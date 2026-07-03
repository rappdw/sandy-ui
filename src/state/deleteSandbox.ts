// Filesystem mutations on sandboxes. Safety-first:
// - Every path must be a sub-path of ~/.sandy/sandboxes/ (defends against
//   any bug that could pass a wild path — never blindly rm -rf an
//   arbitrary string).
// - The actual deletion calls are wrapped in try/catch so failures bubble
//   out as typed errors.
// - Callers are responsible for user-facing confirmation modals AND for
//   refusing to act on running sandboxes (we have no way to stop a
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

// Lock filename convention sandy uses: ~/.sandy/sandboxes/.<sandbox-name>.lock
// (file OR directory; this function rm -rf's either).
export function lockPathForSandbox(sandboxName: string, sandboxesRoot: string = SANDBOXES_ROOT): string {
  return path.join(sandboxesRoot, `.${sandboxName}.lock`);
}

export function removeLockForSandbox(sandboxName: string, sandboxesRoot: string = SANDBOXES_ROOT): DeleteResult {
  if (!sandboxName) return { ok: false, error: "no sandbox name provided" };
  const lockPath = lockPathForSandbox(sandboxName, sandboxesRoot);
  return removePathInsideRoot(lockPath, sandboxesRoot, "lock");
}

export function deleteSandboxDir(sandboxPath: string, sandboxesRoot: string = SANDBOXES_ROOT): DeleteResult {
  return removePathInsideRoot(sandboxPath, sandboxesRoot, "sandbox dir");
}

// Shared safety-checked rm. The `kind` label is for error messages only.
function removePathInsideRoot(targetPath: string, rootPath: string, kind: string): DeleteResult {
  if (!targetPath) return { ok: false, error: `no path provided for ${kind}` };

  // Normalize both paths and verify containment. resolve() collapses ".."
  // segments (it does NOT follow symlinks — but rmSync unlinks a symlink
  // rather than traversing into its target, so a link inside the root can't
  // be used to delete content outside it). The check below catches
  // "../../../tmp" attacks and anything outside the allowed root.
  const resolved   = path.resolve(targetPath);
  const rootResolved = path.resolve(rootPath);
  const rel = path.relative(rootResolved, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      ok: false,
      error: `refusing to delete ${kind}: path "${targetPath}" is not under ${rootPath}`,
    };
  }

  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `${kind} does not exist: ${resolved}` };
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return { ok: true, removedPath: resolved };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
