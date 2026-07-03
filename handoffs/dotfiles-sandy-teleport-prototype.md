# Handoff: `sandy-teleport` prototype (dotfiles) — move a workspace + sandy session to a remote host

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) working in the **dotfiles** repo. This is the *prototype* tier
> of a three-tier plan: validate the flow as a standalone script here, feed
> findings back into the full `sandy teleport` subcommand (tracked upstream at
> <https://github.com/rappdw/sandy/issues/16>), and finish with thin sandy-ui
> integration. Treat this script as a proving ground — correctness and safety
> gates matter, polish doesn't.

---

## Task: write a standalone `sandy-teleport` script + `sandy` shell-wrapper guard

The owner runs [sandy](https://github.com/rappdw/sandy) (Dockerized coding-agent
sandbox) on a Mac laptop and has always-on SSH-reachable servers (`dgx`,
`alice` — see the existing mosh/tmux helper functions in
`macbook/shell/zshrc`). Goal: checkpoint an in-progress sandy workload —
workspace files **plus the agent's accumulated context/memory** — and resume
it on a server inside tmux, so it keeps working when the laptop sleeps.
Then move it back later.

Deliverables, following this repo's conventions for where executables and
shell functions live:

1. `sandy-teleport` — standalone bash script (target: somewhere on PATH,
   e.g. alongside other personal bin scripts).
2. A `sandy()` wrapper function for zshrc — the split-brain launch guard
   (see below).

## What "the session" physically is (verified against sandy's source, June 2026)

Sandy stores everything per-project on the **host**:

| State | Location |
|---|---|
| Agent context/memory/transcripts/plugins | `~/.sandy/sandboxes/<SANDBOX_NAME>/claude/` (mounted at `~/.claude` in-container) |
| Claude setup sidecar | `~/.sandy/sandboxes/<SANDBOX_NAME>.claude.json` |
| Per-project package installs (pip/npm/go/cargo/uv) | subdirs of `~/.sandy/sandboxes/<SANDBOX_NAME>/` |
| Workspace (incl. uncommitted/untracked + `.sandy/`) | the project dir |
| Workspace lock (mkdir mutex, live PID inside) | `~/.sandy/sandboxes/.<SANDBOX_NAME>.lock` |
| Credentials | **not in the sandbox** — seeded fresh from host each launch (do NOT transfer; remote has its own) |
| Approval records | `~/.sandy/approvals/` (do NOT transfer — re-approval remotely is correct) |

Two facts make the transferred state resumable:

1. **`SANDBOX_NAME = <basename>-<hash8>`** where:
   ```bash
   # replicate sandy's algorithm exactly:
   hash8="$(printf '%s' "$WORKSPACE_ABS_PATH" | sha256sum | cut -c1-8)"   # Linux
   # macOS: shasum -a 256. The path is canonical (pwd -P), no trailing slash.
   base="$(basename "$WORKSPACE_ABS_PATH" | tr -cd 'a-zA-Z0-9._-')"
   ```
   The hash covers the **absolute host path**, so `/Users/rappdw/dev/foo` and
   `/home/rappdw/dev/foo` produce different names. **The transfer must
   recompute the destination hash and rename the sandbox dir, sidecar, and
   any lock remnants** — otherwise remote sandy ignores the transferred state
   and creates a fresh sandbox.
2. **In-container paths are host-independent when home-relative paths match.**
   Sandy mounts workspaces under `$HOME` at `/home/claude/<rel-path>`, so Mac
   `~/dev/foo` and Linux `~/dev/foo` look identical inside the container and
   Claude's transcripts resume with zero rewriting (`sandy --continue`).
   **v1 requirement**: same home-relative path on both ends; refuse
   workspaces outside `$HOME`.

## CLI surface (prototype scope)

```
sandy-teleport <host>               # checkpoint + push + resume in remote tmux
sandy-teleport <host> --back       # pull it back; clears the marker
sandy-teleport <host> --dry-run    # print every command, execute nothing
sandy-teleport <host> --no-resume  # transfer only
sandy-teleport --status            # show this workspace's teleport marker
```

`<host>` = SSH alias from `~/.ssh/config`. Run from inside the workspace dir.
Skip `--provision` tooling for now — do the remote prep manually once
(sandy installed + same version, docker, tmux, `CLAUDE_CODE_OAUTH_TOKEN` in
remote `~/.sandy/.secrets`, `gh auth login`, images pre-built by running
sandy once in a scratch dir).

## Forward flow

1. **Quiesce gate (hard).** Refuse if `~/.sandy/sandboxes/.<NAME>.lock`
   holds a live PID or `docker ps` shows `sandy-<NAME>` running. Tell the
   user to exit sandy first. Never copy live state. Note in output:
   "teleport checkpoints at the last completed agent message — anything
   mid-turn is not captured."
2. **Preflight (before any bytes move):** `ssh <host> true`; remote
   `sandy --version` **exactly matches** local (prototype: refuse on any
   mismatch); remote docker reachable; arch comparison (`uname -m` both
   sides — on mismatch refuse unless `--fresh-packages` skips the package
   subdirs); remote creds present (`~/.sandy/.secrets` mentions
   CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY); no live lock for the
   destination sandbox name remotely.
3. **Workspace rsync**: `rsync -a --delete` to the same home-relative path,
   with `--backup --backup-dir=~/.sandy/teleport-backups/<timestamp>/` on
   the destination so `--delete` is never irreversible.
4. **Session rsync**: sandbox dir + `.claude.json` sidecar → destination,
   **renamed to the recomputed destination hash** (compute the remote
   absolute path via `ssh <host> 'echo $HOME'` + the rel path, then hash).
5. **Marker** (split-brain defense): write
   `~/.sandy/sandboxes/<NAME>.teleported.json` on the **source**:
   ```json
   {"host":"dgx","remote_workspace":"/home/rappdw/dev/foo",
    "remote_sandbox":"foo-9f8e7d6c","teleported_at":"<iso8601>",
    "sandy_version":"<v>"}
   ```
   (Sidecar location, NOT inside the workspace — it must not travel with the
   workspace rsync.)
6. **Resume** (unless `--no-resume`):
   `ssh <host> 'tmux new-session -d -s sandy-<base> "cd <ws> && sandy --continue"'`
   then print the attach hint (`<host>`-helper function / `mosh <host> --
   tmux attach -t sandy-<base>`). Heads-up: sandy runs its own inner tmux
   (prefix `C-b`); document `C-b C-b` to reach the inner one through the
   outer session, or give the outer session a different prefix.

`--back` = same flow reversed: quiesce check on the **remote** (live lock /
container there → refuse with `tmux kill-session` guidance), rsync back,
rename to the *local* hash, clear the marker on success.

## The `sandy()` wrapper guard (zshrc)

The full implementation will have sandy itself refuse to launch while a
teleport marker exists. The prototype can't modify sandy — but dotfiles owns
the shell, so wrap it:

```zsh
sandy() {
  # compute SANDBOX_NAME for $PWD (same hash logic; factor into a helper the
  # script also sources, so the algorithm lives in exactly one place here)
  local marker; marker="$(_sandy_teleport_marker_path "$PWD")"
  if [[ -f "$marker" ]]; then
    echo "⚠ this workspace teleported to $(jq -r .host "$marker") on $(jq -r .teleported_at "$marker")"
    echo "  attach remotely, or: sandy-teleport $(jq -r .host "$marker") --back"
    echo "  (run 'command sandy' to override)"
    return 1
  fi
  command sandy "$@"
}
```

This is the prototype's only launch guard — it protects interactive shells
but not other entry points (sandy-ui, scripts). Acceptable for a prototype;
note it as the first thing the real `sandy teleport` subsumes.

## Edge cases to handle

- macOS `shasum -a 256` vs Linux `sha256sum` (both ends of the hash calc).
- Dead-PID lock remnants on the remote (server rebooted mid-session): clear
  stale locks for the destination sandbox before resume; leave live ones.
- `jq` may not be on PATH → degrade gracefully in the wrapper.
- rsync exclusions: none by default (uncommitted/untracked/.sandy must
  travel — that's the point), but `--fresh-packages` skips the package-store
  subdirs (compiled binaries don't survive arch changes).
- Refuse politely when run outside a directory that has an existing sandbox
  (nothing to teleport — just `git clone` remotely instead).

## Acceptance test (manual, against the dgx)

1. In a scratch repo: `sandy`, exchange two messages with claude, exit.
2. `sandy-teleport dgx --dry-run` → review every printed command.
3. `sandy-teleport dgx` → attach remotely → claude shows the same
   conversation (`--continue` picked up the transferred transcripts).
4. Locally: `sandy` → wrapper blocks with the marker message.
5. Exchange a message remotely, exit, `sandy-teleport dgx --back` →
   locally `sandy --continue` shows all four messages; marker gone.

## Feed findings back

Anything learned here (hash edge cases, rsync surprises, resume behavior,
nested-tmux ergonomics) should flow back as comments on the full spec at
<https://github.com/rappdw/sandy/issues/16> before that's implemented — that
version adds `--print-state` integration, in-sandy launch refusal,
`--provision`, and the exit-code contract that sandy-ui's UI layer consumes.
