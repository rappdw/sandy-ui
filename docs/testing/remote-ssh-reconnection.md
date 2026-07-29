# Runbook: surviving sleep / clamshell on a remote sandy-ui session

You're driving a sandy on an always-on host (a DGX here) from a laptop over VSCode
**Remote-SSH**. You shut the lid, walk away, come back — what should "just work," and how to
make it. This layers three independent fixes; apply them in order and verify each.

## The mental model — three separate layers (fix them in this order)

| Layer | Problem it solves | Where it lives | Status |
|---|---|---|---|
| **1. Daemon session** | *Losing work.* The container/agent keep running on the host regardless of the client. | sandy (`--start` / `sandy.persistSessions`) | shipped — **the only one that's about safety** |
| **2. Wake repaint (Symptom A)** | *Frozen frame.* After wake, the terminal is stuck on the pre-sleep screen until you close+reopen the tab. | sandy-ui (webview heartbeat → SIGWINCH repaint) | shipped (commit `2efafa8` / ≥ 0.8.1) |
| **3. Resilient transport (Symptom B)** | *Sluggish stream.* After wake the terminal is laggy until you reload the whole VSCode window. | transport (Eternal Terminal), below sandy-ui | optional — comfort, self-hosted |

Key framing: **Layer 1 already means you never lose work** — a dropped connection costs a
repaint + maybe a reconnect, never your session. Layers 2 and 3 are comfort. Do 1, then 2,
then 3 only if the stream sluggishness actually bothers you.

Prereqs: the base [`remote-ssh-runbook.md`](remote-ssh-runbook.md) working (sandy-ui installed
in the remote extension host, a session attaches). This runbook is only about the
*after-sleep* experience.

## Layer 1 — Daemon sessions (safety; verify it's on)

On the DGX, sessions must be daemonized so they outlive the client. sandy-ui does this by
default (`sandy.persistSessions: true`, launching via `sandy --start`). Verify:

```bash
# DGX, while a sandy-ui session is attached (strip any shell title-escape; see the base runbook):
sandy --print-state light | perl -pe 's/\e\][^\a]*\a//' | jq '.running_containers[] | {sandbox, daemon, attached_clients}'
```

Expect `daemon: true`. If it's `false`/absent, you're on the legacy lifecycle — check
`sandy.persistSessions` isn't overridden and `sandy.launchCommand` isn't set (either forces
legacy). With `daemon: true`, a lid-close cannot lose the session; everything below is polish.

**Test it:** attach a session, note the screen, close the lid ~1 min, reopen. In a DGX
terminal, `sandy --print-state light | … | jq '.running_containers'` still shows the
container running. Work survived. ✅

## Layer 2 — Wake repaint (Symptom A: frozen frame)

The extension now detects the client waking (a heartbeat notices the wall-clock jump) and
forces a tmux redraw, so the screen self-heals instead of needing a close+reopen. You need a
build that includes it.

**Get the build (≥ commit `2efafa8`):**

- **Local Mac VSCode:** `cd ~/dev/sandy-ui && ./install.sh` (pulls latest, rebuilds, installs), then **Developer: Reload Window**.
- **Remote extension host (the DGX):** rebuild from source there per the base runbook — pull latest `main` first so you get `2efafa8`:
  ```bash
  cd ~/dev/sandy-ui && git pull --ff-only && npm install && npm run compile && npm run package-vsix
  # then reinstall into the remote host (UI "Install from VSIX" or `code --install-extension …`)
  ```
  Reload the Remote-SSH window.

> Both ends matter: the heartbeat lives in the **webview** (renders on the Mac) and the
> repaint is driven by the **extension host** (on the DGX). An old build on either side
> means no auto-repaint.

**Verify:** attach a session, run something with visible output, close the lid ~1 min,
reopen and click into the Sandy tab.
- **Expected:** within ~10s the screen repaints itself to the current tmux state — **no
  close+reopen needed.** (10s = the heartbeat interval; the repaint fires on the first tick
  after wake.)
- The "Sandy" output channel logs `wake: <N>s gap — requesting tmux repaint` and
  `wake: forcing tmux repaint`.

If the frame is still frozen after ~15s: you're on a pre-`2efafa8` build on one side, or the
tab wasn't visible/focused (the repaint targets the visible attached panel).

## Layer 3 — Resilient transport (Symptom B: sluggish stream)

Even with the frame repainted, the *stream* can be laggy after wake — keystrokes/output feel
slow until you reload the entire VSCode window. That's not sandy-ui or tmux: it's the raw
**Remote-SSH connection degraded** after sleep (a full window reload establishes a fresh
client↔server channel, which is why that fixes it). No extension code can fix the transport.

The fix is a transport that resumes cleanly instead of limping — **Eternal Terminal**. Follow
[`remote-ssh-eternal-terminal.md`](remote-ssh-eternal-terminal.md) end to end (ET holds a
resilient link and forwards the ssh port; VSCode rides inside it, so a blip is invisible
rather than a degraded resume).

**Verify:** with ET in place and Layers 1-2 done, attach a session, close the lid ~1 min,
reopen.
- **Expected:** screen repaints (Layer 2) **and** the stream is responsive immediately — no
  full-window reload needed. Compare against the raw-Remote-SSH baseline where you had to
  reload.
- If the stream is still sluggish post-ET, capture it for the ET runbook's report-back
  (it may mean ET didn't resume before VSCode's own timeout — a real finding).

## End-to-end acceptance (all three layers)

The target experience: **lid closes → lid opens → you keep working, no ceremony.**

1. Attach a sandy-ui session over the ET-backed Remote-SSH connection; interact with the agent.
2. Close the lid, wait ≥ 1 minute, reopen.
3. Observe, in order:
   - Session still running on the DGX (Layer 1) — you never lost the agent.
   - Sandy tab repaints itself within ~10s, no close+reopen (Layer 2).
   - The terminal is responsive immediately, no full-window reload (Layer 3).

## After-sleep decision tree (if something's off)

- **Tab is a frozen/stale frame, doesn't self-heal** → Layer 2 not active. Confirm both the
  Mac and the DGX are on a build ≥ `2efafa8`; confirm the tab is the focused/visible one.
- **Screen is current but the stream is sluggish; a full window reload fixes it** → Layer 3.
  That's the degraded SSH channel — stand up ET.
- **"Did I lose my session?"** → No. If `--print-state` shows the daemon container running,
  the session is intact; you're only seeing a client-link symptom (Layer 2 or 3). Persistence
  ≠ connection resilience — a dropped link is never a lost session.
- **Session genuinely gone from `--print-state`** → not a reconnect issue; check whether an
  explicit Stop ran, or sandy's own logs. Reconnection never stops a daemon session.

## Report-back

- Layer 1: `daemon: true` confirmed?
- Layer 2: does the frame self-repaint within ~10s of wake (both ends on ≥ `2efafa8`)?
- Layer 3: with ET, is the post-wake stream responsive without a window reload — vs the raw
  baseline?

Clean across all three → the clamshell workflow is solved; worth a short note in the README's
Remote-SSH section. Anything off → the decision tree says which layer, and the per-layer
runbooks carry the detail.
