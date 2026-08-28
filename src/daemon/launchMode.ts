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
