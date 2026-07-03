import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Sandy's per-workspace lock format (verified against sandy's source):
//   ~/.sandy/sandboxes/.<base>-<8hex>.lock
// where <base> is the workspace basename sanitized exactly like sandy's
// DIR_BASE (`tr -cd 'a-zA-Z0-9._-'`, empty → "project") and <8hex> is the
// first 8 lowercase hex chars of sha256(workspace path). Lock can be a file
// (containing the PID on the first line) or a directory (containing files
// like "pid" with the PID).
//
// Matching must be EXACT on that shape — a loose `.<basename>-` prefix match
// would let workspace "foo" claim "foo-2"'s locks (`.foo-2-<hash>.lock`),
// and the orphan-resolution flow would then offer to SIGTERM another
// project's live sandy.
//
// On VSCode reload / crash sandy's cleanup trap doesn't always run, leaving
// the lock behind even though the PID is dead. This module sweeps for those.

export const DEFAULT_SANDBOX_DIR = path.join(os.homedir(), ".sandy", "sandboxes");

export interface LockSweepResult {
  cleaned: string[];   // lock paths removed (PID was dead)
  alive:   string[];   // lock paths kept (PID is still running)
  unknown: string[];   // lock paths we couldn't parse — left alone
}

// Production callers use sweepStaleLocks (defaults to ~/.sandy/sandboxes/).
// Tests use sweepStaleLocksIn against a tmp dir.
export function sweepStaleLocks(workspaceFsPath: string): LockSweepResult {
  return sweepStaleLocksIn(DEFAULT_SANDBOX_DIR, workspaceFsPath);
}

export function sweepStaleLocksIn(sandboxDir: string, workspaceFsPath: string): LockSweepResult {
  const result: LockSweepResult = { cleaned: [], alive: [], unknown: [] };
  if (!fs.existsSync(sandboxDir)) return result;

  const lockRe = lockNamePattern(workspaceFsPath);

  for (const entry of fs.readdirSync(sandboxDir)) {
    if (!lockRe.test(entry)) continue;
    const lockPath = path.join(sandboxDir, entry);
    const pid = readLockPid(lockPath);
    if (pid == null) {
      result.unknown.push(lockPath);
      continue;
    }
    if (isPidAlive(pid)) {
      result.alive.push(lockPath);
      continue;
    }
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
      result.cleaned.push(lockPath);
    } catch {
      result.unknown.push(lockPath);
    }
  }
  return result;
}

// Exact lock-name matcher for a workspace. Mirrors sandy's naming:
// basename sanitized with tr -cd 'a-zA-Z0-9._-' ("project" when empty),
// then "-" + exactly 8 lowercase-hex hash chars + ".lock", dot-prefixed.
export function lockNamePattern(workspaceFsPath: string): RegExp {
  const sanitized = path.basename(workspaceFsPath).replace(/[^a-zA-Z0-9._-]/g, "") || "project";
  const escaped = sanitized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${escaped}-[0-9a-f]{8}\\.lock$`);
}

export function readLockPid(lockPath: string): number | null {
  try {
    const stat = fs.statSync(lockPath);
    if (stat.isFile()) {
      const text = fs.readFileSync(lockPath, "utf8").trim();
      return parseFirstInt(text);
    }
    if (stat.isDirectory()) {
      for (const name of ["pid", "PID", "lock.pid"]) {
        const f = path.join(lockPath, name);
        if (fs.existsSync(f)) {
          const text = fs.readFileSync(f, "utf8").trim();
          const pid = parseFirstInt(text);
          if (pid != null) return pid;
        }
      }
    }
  } catch { /* fall through */ }
  return null;
}

function parseFirstInt(text: string): number | null {
  const m = text.match(/\d+/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }    // signal 0 = liveness probe
  catch (e) {
    // EPERM = the process exists but belongs to another user — that's ALIVE.
    // Treating it as dead would let the sweep remove a live lock. Only ESRCH
    // (and anything else unexpected) counts as not-running.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
