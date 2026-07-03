// Decides how often (if at all) the StatePoller should invoke
// `sandy --print-state`, given what the user can currently see.
//
// Why this exists: --print-state is expensive on the sandy side — it spawns
// ~9 docker CLI processes per invocation (docker info ×2, image inspect ×6,
// docker ps ×1), each of which is a heavyweight VM round-trip on macOS. An
// unconditional 5s poll in every VSCode window produces a visible sawtooth
// CPU pattern in Activity Monitor. So: poll fast only when the Sandy tree is
// actually visible in a focused window; slow way down when the window is in
// the background; stop entirely when the Sandy view isn't even showing.
//
// Kept free of vscode imports so Vitest can cover the decision table.

export const ACTIVE_POLL_MS = 5_000;
export const BACKGROUND_POLL_MS = 60_000;

/**
 * @returns polling interval in ms, or undefined = don't poll at all.
 */
export function pollCadence(viewVisible: boolean, windowFocused: boolean): number | undefined {
  if (!viewVisible) return undefined;
  return windowFocused ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS;
}
