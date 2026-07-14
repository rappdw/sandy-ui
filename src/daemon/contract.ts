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
