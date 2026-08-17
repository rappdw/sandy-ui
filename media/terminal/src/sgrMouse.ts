// Pure SGR (DECSET 1006) mouse-report encoders, shared with the bridge's
// ⌥-drag tmux-forwarding. DOM- and side-effect-free on purpose so vitest can
// import them directly — bridge.ts itself is a browser IIFE and can't be.
//
// SGR mouse reports: a press or a motion-while-pressed event ends with 'M', a
// release ends with 'm'. Motion sets the +32 flag on the button code. Button
// base codes: 0 = left, 1 = middle, 2 = right. col/row are 1-based cells.

export {}; // module marker (keeps local types out of the shared global scope)

const MOTION_FLAG = 32;

/** Button-press report: `CSI < btn ; col ; row M`. */
export function sgrPress(btn: number, col: number, row: number): string {
  return `\x1b[<${btn};${col};${row}M`;
}

/** Motion-while-pressed report: button code carries the +32 motion flag. */
export function sgrDrag(btn: number, col: number, row: number): string {
  return `\x1b[<${btn + MOTION_FLAG};${col};${row}M`;
}

/** Button-release report: same button code, lowercase `m` terminator. */
export function sgrRelease(btn: number, col: number, row: number): string {
  return `\x1b[<${btn};${col};${row}m`;
}
