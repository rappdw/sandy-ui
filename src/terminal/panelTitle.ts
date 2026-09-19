// The Sandy tab's title — which is also, via VSCode's default
// `window.title` (`${activeEditorShort}${separator}${rootName}`), the LEADING
// text of the OS window title. macOS sorts its Window menu alphabetically by
// that string, so a title starting with "Sandy (attached pid=12345)" sorts a
// user's windows by PID and buries the workspace name where it can do no
// work. Leading with the workspace fixes both asks at once: the tab says
// which project it is, and the Window menu comes out alphabetical.
//
// Pure (path.basename only) so the formatting is unit-testable without the
// extension host.

import * as path from "path";

export type TitleState =
  | { kind: "starting" }
  | { kind: "attached" }
  | { kind: "detached" }
  | { kind: "exited"; code: number }
  /** An OSC-0 title emitted by whatever is running inside the terminal. */
  | { kind: "app"; title: string };

/** Short, human label for a workspace — its basename, or a marker when absent. */
export function workspaceLabel(workspacePath: string | undefined | null): string {
  if (!workspacePath) return "(no workspace)";
  return path.basename(workspacePath) || workspacePath;
}

function detailFor(state: TitleState): string {
  switch (state.kind) {
    case "starting": return "Sandy (starting…)";
    case "attached": return "Sandy";
    case "detached": return "Sandy (detached)";
    case "exited":   return `Sandy (exit ${state.code})`;
    case "app":      return state.title;
  }
}

/**
 * `<workspace> · <detail>`, with the unseen-activity bullet placed AFTER the
 * workspace rather than at the front. A leading "● " would sort every busy
 * window together under one character and undo the reason the workspace leads
 * in the first place.
 *
 * The pid is deliberately gone: it's noise in a tab, it's what made the sort
 * useless, and it's still recorded in the "Sandy" output channel for anyone
 * who actually needs it.
 */
export function panelTitle(
  workspacePath: string | undefined | null,
  state: TitleState,
  activity = false,
): string {
  return `${workspaceLabel(workspacePath)} · ${activity ? "● " : ""}${detailFor(state)}`;
}
