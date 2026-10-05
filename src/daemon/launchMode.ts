// Which lifecycle a launch uses: the daemon two-phase (--start then --attach)
// or the legacy foreground spawn. Pure + separate from webviewPanel.ts (which
// imports vscode and can't be unit-tested) so the precedence is pinned by
// tests rather than by reading the call site.

export interface LaunchModeInputs {
  /** One-launch daemon bypass — see forceLegacy's use in webviewPanel.ts. */
  forceLegacy: boolean;
  /** `sandy.launchCommand` — any value forces the legacy lifecycle. */
  launchCommand: string;
  /** `sandy.persistSessions`. */
  persistSessions: boolean;
  /** `--start` present in --print-schema's cli_flags. */
  daemonCapable: boolean;
  /** A sandy binary actually resolved — nothing to run --start with otherwise. */
  hasSandyBinary: boolean;
}

/**
 * True when the launch should take the daemon path. Every input is a veto:
 * the daemon path requires ALL of them, so any single "no" falls back to the
 * legacy foreground lifecycle. forceLegacy is listed first because it's the
 * caller-driven one-shot override (offered on a --start failure so sandy can
 * run on our pty and actually prompt) — it must not be persisted anywhere.
 */
export function shouldUseDaemon(i: LaunchModeInputs): boolean {
  if (i.forceLegacy) return false;
  if (i.launchCommand.trim() !== "") return false;
  if (!i.persistSessions) return false;
  if (!i.daemonCapable) return false;
  if (!i.hasSandyBinary) return false;
  return true;
}

/** How long after a failed `--start` a live lock is still presumed to be its. */
export const OWN_START_WINDOW_MS = 30 * 60 * 1000;

/**
 * Whether a live workspace lock found by a foreground retry belongs to the
 * `--start` that just failed in this window (sandy-ui#50), rather than to a
 * sandy running elsewhere. A timed-out --start that never created a container
 * skips sandy's teardown, so its background process keeps the lock. Only a
 * forceLegacy retry qualifies: an ordinary launch finding a live lock gets the
 * "running outside this window" prompt.
 */
export function liveLockIsOwnStart(
  forceLegacy: boolean,
  lastFailure: { code: number; at: number } | undefined,
  now: number,
): boolean {
  return forceLegacy && !!lastFailure && now - lastFailure.at >= 0 && now - lastFailure.at < OWN_START_WINDOW_MS;
}
