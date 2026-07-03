# Handoff: make `--print-state` cheap enough to poll (9 docker spawns → 1)

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> sandy-ui dogfooding.

---

## Task: add a light mode to `--print-state` that makes one docker invocation instead of nine

### Context

sandy-ui polls `sandy --print-state` to drive its projects tree (sandbox
list, lock state, running containers). Dogfooding on macOS surfaced a
sawtooth CPU pattern in Activity Monitor traced to the polling: **each
`--print-state` invocation spawns ~9 docker CLI processes**, and on macOS
every docker CLI call is a heavyweight Go binary round-tripping to the
Docker Desktop/Rancher VM (which spikes `com.docker.backend` as well).

Breakdown of one invocation (`_sandy_emit_state`):

| Call | Count | Purpose |
|---|---|---|
| `docker info` | 2 | reachability gate, once for `installed_images`, once for `running_containers` |
| `docker image inspect <img>` | 6 | one per sandy image (base, claude-code, gemini-cli, codex, opencode, full) for `installed_images` |
| `docker ps --format ...` | 1 | `running_containers` |

sandy-ui has mitigated its side (polling is now gated on view visibility +
window focus), but the per-invocation cost is sandy's to fix — and it
benefits every consumer, not just sandy-ui.

Two observations make this nearly free to fix:

1. **`installed_images` has no consumer.** sandy-ui types it `unknown[]` and
   never reads it. It costs 6 of the 9 spawns.
2. **`docker info` is redundant.** It's the most expensive docker query
   (aggregates daemon-wide info) and it's used only as a boolean
   reachability probe — but `docker ps`'s own exit code carries the same
   signal: it fails when the CLI is missing or the daemon is unreachable,
   succeeds otherwise.

### Proposed change

Support `sandy --print-state light` (second positional arg; see
compatibility note below for why this shape). In light mode:

- **Skip `installed_images` entirely** — emit `"installed_images": []` (keep
  the key so the schema shape is stable; consumers that ever cared would opt
  into full mode).
- **Derive `docker_reachable` from the single `docker ps` call**: run it
  once, capture output + exit status. Exit 0 → `docker_reachable: true` and
  parse the output for `running_containers`. Non-zero (or `docker` not on
  PATH) → `docker_reachable: false`, `running_containers: null` — the same
  semantics the two `docker info` gates produce today.
- Everything else (sandboxes walk, locks, approvals) unchanged — it's all
  local filesystem and costs microseconds by comparison.

Net: **exactly one docker spawn per light invocation**, zero when docker
isn't installed.

Default (`sandy --print-state` with no arg) stays byte-for-byte identical to
today — this is additive per the SPEC_INTROSPECTION contract; no
schema_version bump needed. Optionally the full path can also adopt the
`docker ps`-as-probe trick (dropping it to 7 spawns) — nice but not the
point.

### Compatibility note (why a positional arg, not a new flag position)

The introspection dispatch matches only `$1`:

```bash
if [[ "${1:-}" == "--print-state" ]]; then ... exit 0; fi
```

Extra args are ignored today, so `sandy --print-state light` is
**forward-compatible**: sandy-ui can start passing `light` immediately, and
on an older sandy it degrades to the current (expensive but correct)
behavior. No version detection dance needed on the consumer side. Keep that
property — read `"${2:-}"` inside the handler.

### Acceptance criteria

- `sandy --print-state light` emits valid JSON with the same top-level keys
  as full mode; `installed_images` is `[]`.
- With docker running: `docker_reachable: true`, `running_containers`
  populated, and exactly **one** docker process spawned (verifiable with
  `SANDY_TRACE=1`-style instrumentation, dtruss/execsnoop, or a PATH shim
  `docker` wrapper that counts invocations).
- With docker stopped: `docker_reachable: false`,
  `running_containers: null`, zero hangs (docker ps fails fast; keep any
  existing timeout discipline).
- `sandy --print-state` (no arg) output is unchanged.
- Older-sandy compatibility: `sandy --print-state light` on the current
  released sandy produces the same output as `--print-state` (arg ignored) —
  i.e., the consumer can pass it unconditionally.

### Consumer follow-up (sandy-ui repo, not here)

Once released, sandy-ui's `StatePoller.invoke()` adds `"light"` to its
`execFile` args unconditionally (safe per the compatibility note). That's a
one-line change tracked in the sandy-ui repo.
