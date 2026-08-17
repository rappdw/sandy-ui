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

export const ATTACH_EXIT = { SESSION_ENDED: 0, DETACHED: 3, NO_SESSION: 4, FAILED: 5 } as const;
export const STOP_EXIT   = { STOPPED: 0, NO_SESSION: 4, FAILED: 5 } as const;

export type AttachOutcome = "ended" | "detached" | "no-session" | "failed";

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
