// What to tell the host after the webview re-measures the terminal (sandy-ui#55).
// Pure, so the decision is unit-tested (test/terminal-resizeSync.test.ts).
//
// Switching to another editor tab and back can leave the Sandy terminal with
// its bottom rows blank (the agent's status line gone) or rendered smaller than
// the tab. While VSCode collapses and re-expands the iframe, xterm.js can be
// fitted to a transient size. Shrinking xterm's grid and growing it back
// blanks the bottom rows locally, and the pty may never see the transient size
// (the host drops resizes while the panel isn't visible). When the real size
// comes back it is the size the pty already has, and an unchanged TIOCSWINSZ
// sends no SIGWINCH, so tmux never redraws the rows xterm lost.
//
// So: once xterm's grid has changed size since the last repaint, the next
// refit asks for a REPAINT: the host has tmux redraw the whole screen from its
// own grid (`tmux refresh-client`, src/terminal/tmuxRefresh.ts). With no size
// change it sends a plain resize, or nothing.

/** Below this a measurement is a layout-transition artifact, not a real size. */
export const MIN_COLS = 20;
export const MIN_ROWS = 5;

export interface SyncState {
  /** The size last sent to the host. */
  lastCols: number;
  lastRows: number;
  /** xterm's grid changed size since the last repaint was requested. */
  resizedSinceRepaint: boolean;
}

export type SyncAction =
  | { kind: "none" }
  | { kind: "ignore"; why: string }
  | { kind: "resize" | "repaint"; cols: number; rows: number };

export function syncAfterRefit(s: SyncState, cols: number, rows: number): { action: SyncAction; next: SyncState } {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return { action: { kind: "ignore", why: `squished ${cols}x${rows}` }, next: s };
  }
  if (s.resizedSinceRepaint) {
    return {
      action: { kind: "repaint", cols, rows },
      next: { lastCols: cols, lastRows: rows, resizedSinceRepaint: false },
    };
  }
  if (cols === s.lastCols && rows === s.lastRows) return { action: { kind: "none" }, next: s };
  return { action: { kind: "resize", cols, rows }, next: { ...s, lastCols: cols, lastRows: rows } };
}
