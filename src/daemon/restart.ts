// Riding out `sandy --update-sessions` (sandy-ui#36). It rebuilds images while
// sessions keep running, then restarts each stale session with `sandy --stop`
// followed by `sandy --start`, so the same sandbox comes back in a new
// container. An attached client sees the session end and `--attach` exits 0.
// Instead of leaving the tab dead, sandy-ui waits for the sandbox to come back
// and attaches again. Pure: the polling loop lives in webviewPanel.ts.

/** How often to look, and how long to wait. The stop-to-start gap is usually
 * seconds, but nothing bounds it (`--start` alone allows 600s). */
export const RESTART_POLL_MS = 2_000;
export const RESTART_WAIT_MS = 5 * 60_000;

export interface RestartWatch {
  /** The sandbox's container was seen gone at least once. */
  sawGone: boolean;
  /** updated_at of the container still listed when watching began. */
  baseline?: string | null;
  /** Whether a container has been observed at all yet. */
  observed: boolean;
}

export const newRestartWatch = (): RestartWatch => ({ sawGone: false, observed: false });

/**
 * Feed one `--print-state light` observation of the sandbox's container
 * (undefined = not running). Returns whether a NEW session is up: either it
 * came back after being seen gone, or its updated_at changed from the value
 * it had when watching began (the old container may still be listed for a
 * moment after --attach exits).
 */
export function observeRestart(w: RestartWatch, container: { updated_at?: string | null } | undefined): { watch: RestartWatch; restarted: boolean } {
  if (!container) return { watch: { ...w, sawGone: true, observed: true }, restarted: false };
  const updated = container.updated_at ?? null;
  if (w.sawGone) return { watch: w, restarted: true };
  if (!w.observed) return { watch: { ...w, observed: true, baseline: updated }, restarted: false };
  return { watch: w, restarted: updated !== null && updated !== w.baseline };
}

/** `sandy --update-sessions`, scoped to one workspace or all. Never `--idle-for`:
 * an attached session counts as active and would be skipped, the opposite of
 * what pressing the button means. */
export function updateSessionsArgs(workspace?: string): string[] {
  return workspace ? ["--update-sessions", "--yes", "--workspace", workspace] : ["--update-sessions", "--yes"];
}

/**
 * Whether an `--update-sessions` failure was a session's relaunch (`--start`)
 * failing — the one case where an approval may be the cause, since that
 * relaunch's own output goes to /dev/null. Other failures (no Docker, a failed
 * build, a failed --stop) have nothing to do with approvals.
 */
export function restartStartFailed(output: string): boolean {
  return /--start failed for /.test(output);
}
