// Make sandy's inner tmux redraw the whole screen WITHOUT resizing anything
// (sandy-ui#55).
//
// The old way to force a redraw was to toggle the pty size (rows-1, then back).
// tmux redraws on a size change, but it also resizes every pane, twice, within
// ~140ms. A pane shrink blanks its bottom row, and an agent whose renderer
// diffs cells (Claude Code) can take both resizes as one, see its own size
// unchanged, and redraw only the cells it thinks changed: after a reload the
// status line came back as a few scattered digits.
//
// `tmux refresh-client` redraws the client from tmux's own grid, which still
// holds the full screen, and touches no pane. sandy runs tmux inside the
// container on its default socket as the host uid, which is exactly what
// `sandy --exec` (2.7.0) runs a command as. Without a target, tmux picks the
// most recently active client: the one attached through our pty (daemon
// attaches are last-wins, so there's only one).

import * as cp from "child_process";

/** `--exec` must be sandy's first argument. */
export function tmuxRefreshArgs(workspace: string): string[] {
  return ["--exec", "--workspace", workspace, "--", "tmux", "refresh-client"];
}

export const TMUX_REFRESH_TIMEOUT_MS = 10_000;

/** Resolves with an error message, or undefined on success. Never rejects. */
export function refreshTmux(sandyBin: string, workspace: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    cp.execFile(sandyBin, tmuxRefreshArgs(workspace), { encoding: "utf8", timeout: TMUX_REFRESH_TIMEOUT_MS, env },
      (err, _stdout, stderr) => resolve(err ? (stderr.trim() || err.message) : undefined));
  });
}
