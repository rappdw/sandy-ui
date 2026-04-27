# Handoff: replace PID-based workspace locking with flock(2) in sandy

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> the sandy-ui spike (`/spike/SPIKE_RESULTS.md`) as the gold-standard fix for a
> recurring class of stale-lock bugs.

---

## Task: Replace PID-based workspace locking with flock(2)-based locking

### Context

Sandy currently uses a per-workspace lock at `~/.sandy/sandboxes/.<basename>-<hash>.lock`
(file or directory, with a PID written in it). Find the existing implementation
first — search for "lock" in the codebase, especially around the workspace setup
phase that emits messages like "Another sandy is already running in this workspace
(pid X)" and "If that process is dead, remove the stale lock: rm -rf ...".

### The problem

PID-based stale-lock detection is unreliable. Failure modes I've observed and
reasoned about:

1. **Sandy's cleanup trap doesn't always run.** If sandy is killed by SIGKILL,
   if its parent (terminal, IDE extension host, etc.) tears down too fast for
   the trap to complete, or if `docker stop`/`docker network rm` takes longer
   than available shutdown time, the lock survives even though sandy is dead.
2. **PID reuse.** After sandy dies, its PID can be handed to an unrelated
   process. Any consumer doing `kill -0 $PID` will see "alive" and refuse to
   launch.
3. **Reboot.** PIDs reset; the PID in the lock is almost certainly held by
   something else.
4. **Consumers can't distinguish ESRCH from EPERM** when probing the PID, so
   they sometimes clean a live sandy or leave a dead one.

This is a real, recurring issue — there's now a VSCode extension (`sandy-ui`)
being prototyped that wraps sandy as a subprocess, and it hits this constantly
during dev iteration. The sandy-ui side has a best-effort PID-check sweep, but
the right fix is on the sandy side.

### Solution: flock(2) advisory locking

Move to kernel-managed locks. The kernel releases an `flock` automatically when
the holding process dies, regardless of cause (clean exit, SIGKILL, crash,
reboot). This eliminates the entire class of stale-lock problems with no PID
parsing, no liveness probes, no race conditions.

Sketch:

```bash
exec 9<>"$LOCK_FILE"          # open the lock file on fd 9
if ! flock -n 9; then         # non-blocking exclusive lock
  echo "Another sandy is already running for this workspace" >&2
  # optionally read fd 9's content for debug info (PID, start time)
  exit 1
fi
# fd 9 is held for the lifetime of this process; kernel releases on exit
echo "$$ $(date +%s)" >&9
# ... rest of sandy ...
```

Sandy still writes PID + start time + container name into the file for human
inspection (`cat ~/.sandy/sandboxes/...`), but those values are no longer the
authoritative liveness signal — flock holds the truth.

### Cross-platform constraint

`flock(1)` ships with util-linux on Linux but is **not** available on macOS by
default. Sandy supports both. You'll need to handle macOS — options:

- Use `perl -MFcntl=:flock` (perl is preinstalled on macOS and most Linux distros)
- Use `python3 -c "import fcntl..."` (python3 may need installing)
- Detect at runtime: prefer `flock(1)` if available, fall back to a perl wrapper
  (e.g., a small `bin/flock-portable` shell wrapper)

I'd recommend perl as the fallback — it's reliably present on macOS, no install
needed. But you choose; document the rationale.

### Backwards compatibility

- Existing users may have stale lock files from the old format on disk. On
  startup, if the lock file exists but no one has it flock'd (you can detect
  this by trying flock LOCK_EX|LOCK_NB and succeeding immediately), treat it as
  recoverable — log that you cleaned a pre-flock-era lock and continue.
- Don't change the lock file path or naming scheme. The sandy-ui consumer
  already globs for `~/.sandy/sandboxes/.<basename>-*.lock`; keep that working.

### What to deliver

1. **Implementation**: the flock-based locking, with the macOS fallback wired up.
2. **Test coverage**:
   - Happy path: launch sandy, verify lock acquired, second launch errors out
   - Stale recovery: kill -9 a running sandy, verify next launch acquires
     the lock immediately (no manual `rm` needed) and old lock file is reused
   - Cross-platform: tests run on both Linux and macOS in CI
3. **Documentation update**: anywhere the old "If that process is dead, remove
   the stale lock: rm -rf ..." message lived — that hint should no longer be
   needed. Replace with something like "Another sandy is running (pid X, started
   Y). If you believe this is wrong, it's a bug — please file an issue."
4. **CHANGELOG entry** noting the lock format change is backwards-compatible.

### Out of scope

- Don't redesign the workspace identity / hash scheme.
- Don't change Docker network / container teardown logic. (Those have their own
  stale-resource problems — separate task.)
- Don't add a new dependency beyond `flock(1)` and `perl` (or python3 if you
  pick that route).

### Verification before declaring done

Run this manually after implementation:
```bash
# Acquire the lock in one terminal
./sandy --workspace /tmp/sandy-flock-test &
SANDY_PID=$!
sleep 3
# Confirm second launch errors
./sandy --workspace /tmp/sandy-flock-test  # expected: "Another sandy is running"
# Now kill -9 (no chance for trap)
kill -9 $SANDY_PID
# Confirm next launch succeeds without manual cleanup
./sandy --workspace /tmp/sandy-flock-test  # expected: launches cleanly
```

If all three steps behave as expected, the fix is real. If the third step
errors, flock isn't being acquired or released correctly.
