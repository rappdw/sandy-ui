import { describe, it, expect } from "vitest";
import { syncAfterRefit, SyncState, MIN_COLS, MIN_ROWS } from "../media/terminal/src/resizeSync";

// sandy-ui#55: after switching tabs and back, the terminal lost its bottom
// rows (the agent's status line) because xterm had shrunk and regrown locally
// while the pty stayed at the same size, so nothing sent tmux a SIGWINCH.
describe("syncAfterRefit", () => {
  const at = (cols: number, rows: number, resized = false): SyncState =>
    ({ lastCols: cols, lastRows: rows, resizedSinceRepaint: resized });

  it("does nothing when xterm never changed size and the size matches", () => {
    const { action, next } = syncAfterRefit(at(120, 40), 120, 40);
    expect(action).toEqual({ kind: "none" });
    expect(next).toEqual(at(120, 40));
  });

  it("repaints when xterm resized locally, even back to the size the host already has", () => {
    // The #55 case: shrink to 120x37 during the transition (dropped by the
    // host), regrow to 120x40. A resize to 120x40 would be a no-op ioctl.
    const { action, next } = syncAfterRefit(at(120, 37, true), 120, 40);
    expect(action).toEqual({ kind: "repaint", cols: 120, rows: 40 });
    expect(next).toEqual(at(120, 40, false));
  });

  it("repaints once: the settle pass after a repaint is a no-op", () => {
    const first = syncAfterRefit(at(120, 40, true), 120, 40);
    expect(first.action.kind).toBe("repaint");
    expect(syncAfterRefit(first.next, 120, 40).action).toEqual({ kind: "none" });
  });

  it("sends a plain resize when the size differs but xterm's grid hasn't been resized since the last repaint", () => {
    const { action, next } = syncAfterRefit(at(120, 40), 100, 30);
    expect(action).toEqual({ kind: "resize", cols: 100, rows: 30 });
    expect(next).toEqual(at(100, 30));
  });

  it("ignores a squished measurement and keeps the pending repaint for the next pass", () => {
    const s = at(120, 40, true);
    const narrow = syncAfterRefit(s, MIN_COLS - 1, 40);
    expect(narrow.action.kind).toBe("ignore");
    expect(narrow.next).toBe(s);
    expect(syncAfterRefit(s, 120, MIN_ROWS - 1).action.kind).toBe("ignore");
    expect(syncAfterRefit(narrow.next, 120, 40).action).toEqual({ kind: "repaint", cols: 120, rows: 40 });
  });
});
