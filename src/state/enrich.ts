// Best-effort enrichment of --print-state output: when sandy's emitted
// `workspace_path` is missing/null on a sandbox, try to recover it by reading
// the sandbox's WORKSPACE.json file directly.
//
// This is a temporary bridge — sandy should be reading WORKSPACE.json itself
// in --print-state. See handoffs/sandy-print-state-workspace-path.md.
// Once that lands, this enrichment becomes a no-op (workspace_path will
// already be set, the loop short-circuits per entry).

import * as fs from "fs";
import * as path from "path";
import type { SandyState, SandySandbox } from "./types";

// Field names WORKSPACE.json may use for the workspace path, tried in order
// — first string-valued match wins. Sandy currently uses `workspace_path`;
// the others are kept as defensive fallbacks against future schema drift.
const WORKSPACE_PATH_FIELDS = ["workspace_path", "workspace", "path"];

export function enrichWithWorkspaceJson(state: SandyState): SandyState {
  for (const sb of state.sandboxes ?? []) {
    if (sb.workspace_path) continue;        // already set — nothing to do
    if (!sb.path) continue;                 // no sandbox dir to look in
    const recovered = tryReadWorkspaceJson(sb.path);
    if (recovered) sb.workspace_path = recovered;
  }
  return state;
}

function tryReadWorkspaceJson(sandboxDir: string): string | undefined {
  const f = path.join(sandboxDir, "WORKSPACE.json");
  if (!fs.existsSync(f)) return undefined;
  try {
    const obj = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
    for (const name of WORKSPACE_PATH_FIELDS) {
      const v = obj[name];
      if (typeof v === "string" && v.length > 0) return v;
    }
  } catch { /* malformed WORKSPACE.json — fall through */ }
  return undefined;
}

/** Exposed for unit tests. */
export const _internal = { tryReadWorkspaceJson };
