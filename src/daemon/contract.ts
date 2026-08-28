// Single source of truth for sandy 1.1.0's daemon CLI contract. Frozen per
// the "frozen CLI contract" comment on rappdw/sandy-ui#12
// (https://github.com/rappdw/sandy-ui/issues/12#issuecomment — 2026-07-14).
// Pure logic — no vscode/node imports beyond types — so this is unit-testable
// without any extension-host scaffolding.
//
// Exit codes:
//
//   code | --attach                              | --stop
//   -----|----------------------------------------|------------------
//   0    | session ended while attached           | stopped successfully
//   3    | clean detach — session still running   | —
//   4    | no such daemon session                 | no such daemon session
//   5    | attach failed unexpectedly             | teardown failed
//
// The two --attach outcomes callers branch on most: 3 = "user detached,
// session lives" (offer reattach), 0 = "session is over" (fall back to a
// fresh launch).
//
// --start has its own table (rappdw/sandy#221, sandy >= 1.8.1):
//
//   code | --start
//   -----|--------------------------------------------------------------
//   0    | daemon session ready and attachable
//   6    | refused before launch — a startup approval was not granted
//   7    | container crash-looping (RestartCount >= 3)
//   8    | readiness timeout — never became attachable
//
// Older sandy exited 1 for all three failure modes (verified against the v1.7.0
// and v1.8.0 tags, which use 6/7/8 nowhere), so 1 — and anything else —
// classifies as a generic "failed" and MUST stay actionable: a consumer that
// only understood 6/7/8 would regress on every pre-1.8.1 sandy. Note 1 is also
// still reachable on CURRENT sandy from checks that run before the daemon
// dispatcher (docker missing/down, unwritable SANDY_HOME, bad --workspace).
//
// 6 is deliberately coarse upstream — it is "the approve-only pre-pass exited
// nonzero", which covers at least three different situations:
//   - the user declined an answerable y/N approval prompt,
//   - a HARD refusal that is not a prompt at all (e.g. a new escaping symlink
//     since the last approval — sandy errors out and tells the user to clear
//     the approval list or remove the symlink), and
//   - the pre-pass failing for a mundane reason such as a missing binary.
// So do NOT tell the user what to do based on 6 alone: sandy has already
// printed the specific reason and the exact remedy on our terminal. Point
// there rather than promising a prompt that may not exist.

export const ATTACH_EXIT = { SESSION_ENDED: 0, DETACHED: 3, NO_SESSION: 4, FAILED: 5 } as const;
export const STOP_EXIT   = { STOPPED: 0, NO_SESSION: 4, FAILED: 5 } as const;
export const START_EXIT  = { READY: 0, REFUSED: 6, CRASH_LOOP: 7, TIMEOUT: 8 } as const;

export type AttachOutcome = "ended" | "detached" | "no-session" | "failed";
export type StartOutcome  = "ready" | "refused" | "crash-loop" | "timeout" | "failed";

/**
 * Classify a `sandy --start` exit. Anything outside the known table — 1 from a
 * pre-1.8.1 sandy, 1 from a pre-dispatcher check on current sandy, or an
 * unknown future code — is "failed": still a failure, just one we can't
 * explain, so callers keep whatever generic-but-actionable path they have.
 *
 * Signals are NOT handled here and deliberately so: node-pty reports a signal
 * death as exitCode 0 + signal N (see src/terminal/pty.ts), so a signalled
 * `--start` arrives as code 0 and the caller treats it as success and proceeds
 * to --attach — which then fails cleanly through the --attach table. The
 * undefined/null inputs accepted below are defensive only.
 */
export function classifyStartExit(code: number | undefined | null): StartOutcome {
  switch (code) {
    case START_EXIT.READY:      return "ready";
    case START_EXIT.REFUSED:    return "refused";
    case START_EXIT.CRASH_LOOP: return "crash-loop";
    case START_EXIT.TIMEOUT:    return "timeout";
    default:                    return "failed";
  }
}

// Anything outside the known table — including undefined/null (process
// killed by signal, no exit code observed) — classifies as "failed" so
// callers default to the safe/conservative branch.
export function classifyAttachExit(code: number | undefined | null): AttachOutcome {
  switch (code) {
    case ATTACH_EXIT.SESSION_ENDED: return "ended";
    case ATTACH_EXIT.DETACHED:      return "detached";
    case ATTACH_EXIT.NO_SESSION:    return "no-session";
    default:                        return "failed";
  }
}

// DAEMON-ONLY policy layered on top of classifyAttachExit (which stays
// unchanged above — this wraps it, never replaces it). On Unix, node-pty
// reports a signal death as exitCode 0 + signal N and a normal exit as
// exitCode N + signal 0 (WIFEXITED/WIFSIGNALED are mutually exclusive, and
// both fields default to 0), so classifyAttachExit(0) would read a
// signal-killed client as "ended" ("session ended while attached"). For a
// daemon session that's wrong: the pty here is only the LOCAL
// `sandy --attach` CLIENT, a separate process tree from the durable
// host-side daemon session (sandy's D9 rule — the running labeled container
// is the durable truth, not whatever happened to the local client). A signal
// killing the client says nothing about whether the session is still alive.
//
// Windows note: node-pty's Windows path emits exit with ONE argument, so
// `signal` is always undefined there and this degenerates to
// classifyAttachExit. Harmless — sandy is Docker/Unix-only.
//
// So: a signal death (or an explicit detachRequested from our own
// detach()) is classified "detached" rather than falling through to the
// code table. This deliberately fails OPEN. Failing CLOSED would paint
// `[process exited 0]` into a terminal whose session is very much alive and
// make the user think their work was lost; failing open costs at most a
// relaunch — and relaunch re-runs the idempotent `sandy --start` before
// `--attach`, so a session that HAD died is simply recreated rather than
// erroring. Either way the poller re-reads `--print-state` within 5-60s and
// the tree/status bar converge on the truth.
//
// For the DIRECT backend this function does not apply: there the pty IS the
// session, so any exit ends it — that handler doesn't classify at all.
export function classifyDaemonAttachExit(
  code: number | undefined | null,
  signal: number | undefined | null,
  detachRequested: boolean,
): AttachOutcome {
  if (detachRequested) return "detached";
  if (typeof signal === "number" && signal !== 0) return "detached";
  return classifyAttachExit(code);
}

/**
 * User-facing explanation for a failed `sandy --start`, chosen from the exit
 * table. Lives here (pure) rather than inline in webviewPanel.ts so the wording
 * — which is the entire point of branching on these codes — is unit-testable;
 * that module imports vscode and can't be.
 *
 * Every string must be true of what sandy ACTUALLY does on that path. In
 * particular "refused" must not promise a prompt: exit 6 also covers hard
 * refusals that are errors, not questions, and telling the user to answer a
 * prompt that will never appear is the exact failure this branching replaced.
 */
export function startFailureMessage(code: number | undefined | null): string {
  const shown = code ?? "unknown";
  switch (classifyStartExit(code)) {
    case "refused":
      return `Sandy: a startup approval was not granted (exit ${shown}), so the daemon session wasn't started. ` +
             `The terminal shows sandy's reason and the exact fix. Retrying in the foreground runs sandy directly, ` +
             `which lets you answer the prompt if it's an answerable one.`;
    case "crash-loop":
      return `Sandy: the daemon container is crash-looping (exit ${shown}) — sandy is tearing the failed session down. ` +
             `The container log tail is in the terminal.`;
    case "timeout":
      return `Sandy: the daemon session never became attachable (exit ${shown}). ` +
             `The supervisor log tail is in the terminal.`;
    default:
      return `Sandy: sandy --start failed (exit ${shown}). Sandy's own output is in the terminal. ` +
             `If it was waiting on a prompt, retrying in the foreground lets you answer it.`;
  }
}

export function startArgs(workspacePath: string): string[] {
  return ["--start", "--workspace", workspacePath];
}

export function attachArgs(workspacePath: string): string[] {
  return ["--attach", "--workspace", workspacePath];
}

export function stopArgs(workspacePath: string): string[] {
  return ["--stop", "--workspace", workspacePath];
}

export function pruneOrphansArgs(): string[] {
  return ["--prune-orphans"];
}

export function hasDaemonCapability(schema: { capabilities?: { daemonMode: boolean } } | undefined): boolean {
  return schema?.capabilities?.daemonMode === true;
}
