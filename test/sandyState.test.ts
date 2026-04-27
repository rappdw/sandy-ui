import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  sweepStaleLocksIn, readLockPid, isPidAlive,
} from "../src/terminal/sandyState";

let tmp: string;
let sandboxDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-state-test-"));
  sandboxDir = path.join(tmp, "sandboxes");
  fs.mkdirSync(sandboxDir);
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// PID well above max pid range on both Linux (default pid_max 4194304) and
// macOS (default 99999). Practically never assigned. If the test runner has
// pid_max bumped above 9999999, this assumption breaks — see the sentinel
// guard test.
const DEFINITELY_DEAD_PID = 9_999_999;

const writeLockFile = (entry: string, content: string) =>
  fs.writeFileSync(path.join(sandboxDir, entry), content);

const writeLockDir = (entry: string, files: Record<string, string>) => {
  const dir = path.join(sandboxDir, entry);
  fs.mkdirSync(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
};

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a PID well above any reasonable pid_max", () => {
    // Sentinel guard: if this fails, our DEFINITELY_DEAD_PID assumption is wrong
    // for this test runner and the lock-sweep tests below will be unreliable.
    expect(isPidAlive(DEFINITELY_DEAD_PID)).toBe(false);
  });
});

describe("readLockPid", () => {
  it("returns null for non-existent path", () => {
    expect(readLockPid(path.join(tmp, "no-such-file"))).toBeNull();
  });

  it("reads PID from the first numeric content of a file lock", () => {
    const f = path.join(tmp, "lock");
    fs.writeFileSync(f, "12345");
    expect(readLockPid(f)).toBe(12345);
  });

  it("trims whitespace and finds the first integer", () => {
    const f = path.join(tmp, "lock");
    fs.writeFileSync(f, "\n  12345  \n/path/to/workspace\n");
    expect(readLockPid(f)).toBe(12345);
  });

  it("reads PID from a directory-format lock with 'pid' file", () => {
    const dir = path.join(tmp, "lock");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "pid"), "67890");
    expect(readLockPid(dir)).toBe(67890);
  });

  it("falls back to 'PID' (uppercase) and 'lock.pid' filenames in directory locks", () => {
    const a = path.join(tmp, "a"); fs.mkdirSync(a); fs.writeFileSync(path.join(a, "PID"), "111");
    const b = path.join(tmp, "b"); fs.mkdirSync(b); fs.writeFileSync(path.join(b, "lock.pid"), "222");
    expect(readLockPid(a)).toBe(111);
    expect(readLockPid(b)).toBe(222);
  });

  it("returns null for empty file", () => {
    const f = path.join(tmp, "lock");
    fs.writeFileSync(f, "");
    expect(readLockPid(f)).toBeNull();
  });

  it("returns null for content with no integers (garbage)", () => {
    const f = path.join(tmp, "lock");
    fs.writeFileSync(f, "not a pid at all\nstill not\n");
    expect(readLockPid(f)).toBeNull();
  });

  it("returns null for PID 0 (invalid)", () => {
    const f = path.join(tmp, "lock");
    fs.writeFileSync(f, "0");
    expect(readLockPid(f)).toBeNull();
  });

  it("returns null for directory lock with no recognized PID file", () => {
    const dir = path.join(tmp, "lock");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "metadata.json"), `{"pid":42}`);
    expect(readLockPid(dir)).toBeNull();
  });
});

describe("sweepStaleLocksIn", () => {
  it("returns empty result when sandbox dir doesn't exist", () => {
    const r = sweepStaleLocksIn(path.join(tmp, "nonexistent"), "/any/workspace");
    expect(r).toEqual({ cleaned: [], alive: [], unknown: [] });
  });

  it("ignores files that don't match the workspace basename prefix", () => {
    writeLockFile(".other-workspace-deadbeef.lock", String(DEFINITELY_DEAD_PID));
    writeLockFile(".myproject-cafebabe.lock",     String(DEFINITELY_DEAD_PID));
    const r = sweepStaleLocksIn(sandboxDir, "/path/to/myproject");
    expect(r.cleaned).toEqual([path.join(sandboxDir, ".myproject-cafebabe.lock")]);
    expect(fs.existsSync(path.join(sandboxDir, ".other-workspace-deadbeef.lock"))).toBe(true);
  });

  it("ignores entries that don't end in .lock (defensive)", () => {
    writeLockFile(".myproject-aaa.lock.tmp",       String(DEFINITELY_DEAD_PID));
    writeLockFile(".myproject-aaa.lockfile",       String(DEFINITELY_DEAD_PID));
    writeLockFile(".myproject-aaa.lock",           String(DEFINITELY_DEAD_PID));
    const r = sweepStaleLocksIn(sandboxDir, "/x/myproject");
    expect(r.cleaned).toEqual([path.join(sandboxDir, ".myproject-aaa.lock")]);
    expect(r.alive).toEqual([]);
    expect(fs.existsSync(path.join(sandboxDir, ".myproject-aaa.lock.tmp"))).toBe(true);
    expect(fs.existsSync(path.join(sandboxDir, ".myproject-aaa.lockfile"))).toBe(true);
  });

  it("cleans dead-PID file locks", () => {
    writeLockFile(".ws-1.lock", String(DEFINITELY_DEAD_PID));
    const r = sweepStaleLocksIn(sandboxDir, "/whatever/ws");
    expect(r.cleaned).toHaveLength(1);
    expect(r.alive).toEqual([]);
    expect(fs.existsSync(path.join(sandboxDir, ".ws-1.lock"))).toBe(false);
  });

  it("cleans dead-PID directory locks (recursive removal)", () => {
    writeLockDir(".ws-2.lock", { pid: String(DEFINITELY_DEAD_PID), workspace: "/whatever/ws" });
    const r = sweepStaleLocksIn(sandboxDir, "/whatever/ws");
    expect(r.cleaned).toHaveLength(1);
    expect(fs.existsSync(path.join(sandboxDir, ".ws-2.lock"))).toBe(false);
  });

  it("preserves live-PID locks (uses current process as the sentinel)", () => {
    writeLockFile(".ws-3.lock", String(process.pid));
    const r = sweepStaleLocksIn(sandboxDir, "/whatever/ws");
    expect(r.alive).toHaveLength(1);
    expect(r.cleaned).toEqual([]);
    expect(fs.existsSync(path.join(sandboxDir, ".ws-3.lock"))).toBe(true);
  });

  it("buckets unparseable locks separately and leaves them alone", () => {
    writeLockFile(".ws-4.lock", "garbage no pid here");
    const r = sweepStaleLocksIn(sandboxDir, "/whatever/ws");
    expect(r.unknown).toHaveLength(1);
    expect(r.cleaned).toEqual([]);
    expect(r.alive).toEqual([]);
    expect(fs.existsSync(path.join(sandboxDir, ".ws-4.lock"))).toBe(true);
  });

  it("handles a mix of dead/live/unknown across multiple locks for one workspace", () => {
    writeLockFile(".myws-aaa.lock", String(DEFINITELY_DEAD_PID));   // cleaned
    writeLockFile(".myws-bbb.lock", String(process.pid));            // alive
    writeLockFile(".myws-ccc.lock", "garbage");                       // unknown
    writeLockFile(".other-zzz.lock", String(DEFINITELY_DEAD_PID));   // ignored (different basename)
    const r = sweepStaleLocksIn(sandboxDir, "/x/myws");
    expect(r.cleaned).toHaveLength(1);
    expect(r.alive).toHaveLength(1);
    expect(r.unknown).toHaveLength(1);
    // The other-workspace lock is untouched
    expect(fs.existsSync(path.join(sandboxDir, ".other-zzz.lock"))).toBe(true);
  });
});
