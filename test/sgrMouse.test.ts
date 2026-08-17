import { describe, it, expect } from "vitest";
import { sgrPress, sgrDrag, sgrRelease } from "../media/terminal/src/sgrMouse";

// The bridge synthesizes these straight to the PTY so tmux (mouse on) acts on
// an ⌥-drag as a real click/drag. The exact byte shape matters: a wrong
// terminator or a missing motion flag makes tmux ignore the sequence or
// misread press vs release, so pin the encoding.
describe("sgrMouse encoders", () => {
  it("encodes a left-button press ending in M", () => {
    expect(sgrPress(0, 10, 5)).toBe("\x1b[<0;10;5M");
  });

  it("encodes motion-while-pressed with the +32 flag, still ending in M", () => {
    expect(sgrDrag(0, 10, 5)).toBe("\x1b[<32;10;5M");
  });

  it("encodes a release ending in lowercase m", () => {
    expect(sgrRelease(0, 10, 5)).toBe("\x1b[<0;10;5m");
  });

  it("carries the button base code through press/drag/release", () => {
    // Right button (2): drag flag is 2 + 32 = 34.
    expect(sgrPress(2, 1, 1)).toBe("\x1b[<2;1;1M");
    expect(sgrDrag(2, 1, 1)).toBe("\x1b[<34;1;1M");
    expect(sgrRelease(2, 1, 1)).toBe("\x1b[<2;1;1m");
  });

  it("press and release differ only by terminator (M vs m)", () => {
    const col = 42, row = 7;
    expect(sgrPress(0, col, row).slice(0, -1)).toBe(sgrRelease(0, col, row).slice(0, -1));
    expect(sgrPress(0, col, row).endsWith("M")).toBe(true);
    expect(sgrRelease(0, col, row).endsWith("m")).toBe(true);
  });
});
