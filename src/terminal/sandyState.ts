import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Sandy's per-workspace lock format observed in the wild:
//   ~/.sandy/sandboxes/.<basename>-<8hex>.lock
// where <8hex> is a hash of the full workspace path. Lock can be a file
// (containing the PID on the first line) or a directory (containing files
// like "pid" with the PID).
//
// On VSCode reload / crash sandy's cleanup trap doesn't always run, leaving
// the lock behind even though the PID is dead. This module sweeps for those.

const SANDBOX_DIR = path.join(os.homedir(), ".sandy", "sandboxes");

export interface LockSweepResult {
  cleaned: string[];   // lock paths removed (PID was dead)
  alive:   string[];   // lock paths kept (PID is still running)
  unknown: string[];   // lock paths we couldn't parse — left alone
}

export function sweepStaleLocks(workspaceFsPath: string): LockSweepResult {
  const result: LockSweepResult = { cleaned: [], alive: [], unknown: [] };
  if (!fs.existsSync(SANDBOX_DIR)) return result;

  const baseName = path.basename(workspaceFsPath);
  const prefix = `.${baseName}-`;

  for (const entry of fs.readdirSync(SANDBOX_DIR)) {
    if (!entry.endsWith(".lock") || !entry.startsWith(prefix)) continue;
    const lockPath = path.join(SANDBOX_DIR, entry);
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

function readLockPid(lockPath: string): number | null {
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

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }    // signal 0 = liveness probe
  catch { return false; }
}
