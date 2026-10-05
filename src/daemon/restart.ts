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

/**
 * How long the SAME container may stay listed after --attach exits 0 before
 * we conclude the user ended the session. Ending the agent ends the inner tmux
 * session but leaves a daemon container running (its main process is `tail`
 * under docker-init), so it stays in running_containers. `sandy --stop` — what
 * --update-sessions does before relaunching — removes the container, which can
 * take a few seconds (docker stop's grace period), so a short grace window
 * keeps a slow stop from reading as "the user ended it".
 */
export const USER_ENDED_GRACE_MS = 15_000;

export interface RestartWatch {
  /** The sandbox's container was seen gone at least once. */
  sawGone: boolean;
  /** updated_at of the container still listed when watching began. */
  baseline?: string | null;
  /** Whether a container has been observed at all yet. */
  observed: boolean;
  /** When the original container was first seen still listed (ms). */
  listedSince?: number;
}

export const newRestartWatch = (): RestartWatch => ({ sawGone: false, observed: false });

export type RestartVerdict = "restarted" | "user-ended" | "waiting";

/**
 * Feed one `--print-state light` observation of the sandbox's container
 * (undefined = not running) at time `now`.
 *  - "restarted": a NEW session is up — it came back after being seen gone,
 *    or its updated_at changed from the value it had when watching began.
 *  - "user-ended": the original container has stayed listed, unchanged, for
 *    USER_ENDED_GRACE_MS — the user ended the agent; nothing is restarting.
 *  - "waiting": keep polling.
 * A heuristic, from the sandy maintainer's reading of the design: a user's own
 * `sandy --stop` from another terminal also removes the container, and that
 * looks like a restart until the overall bound runs out.
 */
export function observeRestart(w: RestartWatch, container: { updated_at?: string | null } | undefined, now: number): { watch: RestartWatch; verdict: RestartVerdict } {
  if (!container) return { watch: { ...w, sawGone: true, observed: true, listedSince: undefined }, verdict: "waiting" };
  const updated = container.updated_at ?? null;
  if (w.sawGone) return { watch: w, verdict: "restarted" };
  if (!w.observed) return { watch: { ...w, observed: true, baseline: updated, listedSince: now }, verdict: "waiting" };
  if (updated !== null && updated !== w.baseline) return { watch: w, verdict: "restarted" };
  const since = w.listedSince ?? now;
  return { watch: { ...w, listedSince: since }, verdict: now - since >= USER_ENDED_GRACE_MS ? "user-ended" : "waiting" };
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
