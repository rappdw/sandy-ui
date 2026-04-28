# Handoff: bulletproof Docker network cleanup in sandy

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Surfaced from
> sandy-ui dogfooding.

---

## Task: eliminate Docker network leakage from sandy across crash / Cmd+Q / SIGKILL paths

### Context

Sandy creates an isolated Docker network per session (`docker network create
... sandy-<workspace-hash>`) and tears it down in its cleanup trap (`docker
network rm`). When the trap runs, this works fine. The problem: the trap
**doesn't always run**, and abandoned networks accumulate fast.

Symptoms observed during dogfooding (sandy-ui as the client):

- After several iterations of "launch sandy, close VSCode, relaunch" cycles,
  sandy fails to start a new session with:
  > `Error response from daemon: all predefined address pools have been fully subnetted`
- `docker network ls | grep sandy` shows dozens of orphan networks
- `docker network prune -f` recovers, but the user has to know to do it

When the trap fails to run:

1. **Force-kill of sandy** (SIGKILL, OOM kill, kernel panic) — trap can't run
2. **Container exit while trap still racing** — `docker stop` returned but
   the trap hasn't reached `docker network rm` yet, sandy itself is killed
3. **VSCode quit budget exceeded** — sandy-ui's `deactivate()` gives sandy
   ~4s for SIGINT cleanup before escalating SIGTERM/SIGKILL. If sandy's
   trap is mid-`docker stop` (which can take 10s+), the network cleanup
   never reaches.
4. **Docker daemon hiccups** — `docker network rm` racey when the container
   hasn't fully released its bridge interface

### The fix has two parts: more robust cleanup AND prune-on-startup

#### Part 1: more robust cleanup-trap behavior

Make the cleanup trap idempotent and resilient:

- Trap fires on **EXIT, SIGINT, SIGTERM, SIGHUP** (not just one of them).
  bash: `trap cleanup EXIT INT TERM HUP`. Catches the partial-exit cases.
- `docker network rm` is **non-fatal in the trap** — log if it fails but
  keep going. Don't let one failure abort the rest of cleanup.
- Network rm should **retry briefly** if it fails with "has active endpoints"
  — the container's bridge interface takes a moment to release. Loop ~3
  times, 500ms apart. After that, give up and log.
- Prefer **`docker network rm --force`** if available (newer docker versions),
  which forcibly disconnects endpoints rather than failing.

Today, when the trap fails to clean a network, that network leaks
permanently — there's no other path that touches it.

#### Part 2: prune-orphans on startup (the real fix)

Even with a perfect trap, force-kill scenarios will always exist (kernel
panics, force-quit, OS-level kills). The right architectural answer is:
**clean up other people's mess on startup**, before doing anything else.

Add a startup phase in sandy that:

1. Lists all networks with the sandy prefix (`docker network ls --filter
   name=sandy- --format '{{.Name}}'`)
2. For each network, checks whether any container is still attached to it
   (`docker network inspect <name>`)
3. If no container is attached, the network is orphaned — `docker network rm`
   it. Log what was cleaned.
4. Skip networks for currently-running sandy containers (those are in use)

This runs ONCE per `sandy --start` (or per bare-`sandy` interactive launch),
costs <100ms when there's nothing to clean, and eliminates the recurring
"address pool exhausted" error class.

Add a CLI flag for the user-explicit case too: `sandy --prune-orphans`
(non-destructive — only cleans networks with no active containers; never
touches running sandboxes).

### Alternative considered: docker-side `--rm-network`

Docker doesn't have a per-container "remove network on container exit" flag
the way `--rm` works for containers. So this needs to be sandy-side cleanup,
not a docker config knob.

### What to deliver

1. **Cleanup trap improvements** in sandy's main script:
   - Trap on EXIT INT TERM HUP
   - Network rm with retry loop + non-fatal failure
   - Use `--force` when available
2. **Startup orphan-prune** — runs at the top of `sandy --start` (or bare
   `sandy`), before container creation. Skips active networks.
3. **`sandy --prune-orphans`** CLI flag — explicit user-invoked cleanup.
   Outputs JSON-friendly (or human-readable + machine-readable via flag) so
   sandy-ui can call it.
4. **Tests**:
   - Create a network manually with `sandy-` prefix, no container — verify
     prune-on-startup removes it
   - Create a sandy session, verify `--prune-orphans` does NOT remove the
     active network
   - Force-kill sandy mid-session, then run a fresh sandy — verify the
     leaked network from the killed session is cleaned by startup prune
5. **Update `--print-state`** to include an `orphan_networks: number` count
   so sandy-ui can surface "N orphan networks pruned" feedback.

### Out of scope

- Don't touch image cleanup. `docker image prune` is a different concern
  with different blast-radius (might delete user's other images).
- Don't auto-prune on EVERY sandy invocation if it would slow normal launches.
  Single startup-time prune is enough.
- Don't add a daemon process to watch for orphans continuously. The startup
  prune handles 99% of cases; users can run `sandy --prune-orphans`
  manually for the rest.

### Verification

```bash
# Reproduce: simulate a force-kill leak
./sandy --workspace /tmp/sandy-net-test &
SANDY_PID=$!
sleep 5
kill -9 $SANDY_PID  # simulate hard crash, trap can't run
sleep 2

# Confirm leaked network exists
docker network ls --filter name=sandy- --format '{{.Name}}' | grep -q net-test && echo "leaked"
# Expected: prints "leaked"

# Now launch a fresh sandy in a different workspace; startup prune should clean
./sandy --workspace /tmp/sandy-net-test-2 &
SANDY2_PID=$!
sleep 5

# Verify the leaked network is gone, the new one exists
docker network ls --filter name=sandy- --format '{{.Name}}'
# Expected: only the net-test-2 network, not the abandoned net-test one

kill $SANDY2_PID
```

### Why this matters for sandy-ui

The current sandy-ui workaround documented in `docs/SPIKE_RESULTS.md` and
hit during this dogfooding round is "user runs `docker network prune -f`
periodically." That's a wart — users shouldn't need to know about Docker
plumbing.

Once startup prune lands:

- The "address pool exhausted" error class disappears for normal users
- Sandy-ui can stop documenting the manual prune workaround
- The graceful-shutdown gymnastics in `extension.deactivate()` become
  belt-and-suspenders rather than load-bearing — even if cleanup is
  interrupted, the next launch self-heals

The sandy-ui side already handles its corresponding cleanup (sandbox lock
sweep on launch — `src/terminal/sandyState.ts`). Network sweep belongs on
the sandy side because sandy is the one creating networks; sandy-ui has no
business reaching into Docker resources directly.
