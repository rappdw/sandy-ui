// Delete a sandbox directory from disk. Safety-first:
// - Path must be a sub-path of ~/.sandy/sandboxes/ (defends against any
//   bug that could pass a wild path — never blindly rm -rf an arbitrary
//   string).
// - The actual deletion call is wrapped in try/catch so a failed rmSync
//   bubbles out as a typed error.
// - Caller is responsible for the user-facing confirmation modal AND for
//   refusing to delete running sandboxes (we have no way to stop a
//   container from here without invoking sandy/docker).

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SANDBOXES_ROOT = path.join(os.homedir(), ".sandy", "sandboxes");

export interface DeleteResult {
  ok: boolean;
  error?: string;
  removedPath?: string;
}

export function deleteSandboxDir(sandboxPath: string, sandboxesRoot: string = SANDBOXES_ROOT): DeleteResult {
  if (!sandboxPath) return { ok: false, error: "no path provided" };

  // Normalize both paths and verify containment. resolve() collapses .. and
  // symbolic moves; the check below catches "../../../tmp" attacks and
  // anything outside ~/.sandy/sandboxes/.
  const resolved   = path.resolve(sandboxPath);
  const rootResolved = path.resolve(sandboxesRoot);
  const rel = path.relative(rootResolved, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      ok: false,
      error: `refusing to delete: path "${sandboxPath}" is not under ${sandboxesRoot}`,
    };
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `path does not exist: ${resolved}` };
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return { ok: true, removedPath: resolved };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
