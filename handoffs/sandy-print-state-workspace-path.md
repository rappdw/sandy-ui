# Handoff: surface workspace_path in `sandy --print-state` output

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> sandy-ui dogfooding.

---

## Task: ensure every sandbox in `sandy --print-state` has a `workspace_path` field

### Context

Per `SPEC_INTROSPECTION.md`, each entry in `sandboxes[]` from `--print-state`
should include a stable `workspace_path` string. The sandy-ui VSCode
extension uses this to:

1. Render each sandbox in its activity-bar tree with the workspace path as
   the label
2. Wire tree-item click → `sandy.launch` with that workspace, so users can
   launch in the right workspace from the tree

Currently: when sandy-ui invokes `--print-state`, some (or all) sandbox
entries are missing the `workspace_path` field. Without it, the tree has to
fall back to the sandbox name, and clicking does nothing useful (extension
can't launch sandy in an unknown workspace).

The author tells me sandy now writes a `WORKSPACE.json` file inside each
sandbox directory containing the workspace path. Sandy's `--print-state`
should be reading that file and surfacing the field.

### What to deliver

1. **Find the existing `--print-state` implementation** — search for the
   command name and the function that walks `~/.sandy/sandboxes/` to build
   the `sandboxes[]` array.

2. **For each sandbox dir**, read `<sandbox>/WORKSPACE.json` and pull the
   workspace path field. The exact field name is whatever sandy currently
   writes — verify by reading the code that creates WORKSPACE.json. (Likely
   `workspace`, but confirm.) Set the resulting JSON output's
   `workspace_path` to that value.

3. **Handle missing/malformed cases gracefully**:
   - If `WORKSPACE.json` doesn't exist (legacy sandbox from before this file
     was introduced), set `workspace_path: null` and continue. Don't fail
     the whole `--print-state` call.
   - If `WORKSPACE.json` exists but is malformed JSON, log a warning to
     stderr and set `workspace_path: null`.

4. **Tests**:
   - `--print-state` against a sandbox dir with `WORKSPACE.json` returns the
     correct `workspace_path` in JSON
   - `--print-state` against a sandbox dir without `WORKSPACE.json` returns
     `workspace_path: null` (or absent — match whichever the spec mandates)
   - `--print-state` against a malformed `WORKSPACE.json` doesn't crash and
     still returns the rest of the state

5. **Documentation**: if `SPEC_INTROSPECTION.md` doesn't already document
   that `workspace_path` may be `null` for legacy sandboxes, add a
   one-line note. The extension already handles missing/null gracefully
   (falls back to the sandbox name); the contract should be explicit.

### Out of scope

- Don't redesign `WORKSPACE.json`'s schema.
- Don't backfill `WORKSPACE.json` into existing sandboxes that don't have
  one — that's a separate "migrate old sandboxes" concern; for now, those
  legacy sandboxes will just show with `workspace_path: null` and that's
  acceptable.

### Verification before declaring done

```bash
# Create a fresh sandbox by launching sandy
./sandy --workspace /tmp/sandy-print-state-test &
SANDY_PID=$!
sleep 5
kill $SANDY_PID
sleep 2

# Inspect --print-state — workspace_path should be present
./sandy --print-state | jq '.sandboxes[] | { name, workspace_path }'
# Expected: every entry has a non-null workspace_path matching what was
# passed via --workspace (or VSCode's workspace folder).

# Test the legacy case: manually delete WORKSPACE.json from one sandbox
rm /Users/yours/.sandy/sandboxes/<name>/WORKSPACE.json
./sandy --print-state | jq '.sandboxes[] | { name, workspace_path }'
# Expected: that sandbox now shows workspace_path: null; others still have it.
```

### Why this matters for sandy-ui

Right now sandy-ui has a temporary fallback that reads each sandbox's
`WORKSPACE.json` directly to recover the field — that's a layering
violation (sandy-ui is reaching into sandy's internal file format). Once
this handoff lands, that fallback becomes a no-op and we can delete it.
The extension's pre-launch validation, lock cleanup, and approval flows
all assume `--print-state` is the authoritative source.
