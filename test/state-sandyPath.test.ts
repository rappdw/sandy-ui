import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { resolveSandyBinary, invalidateSandyPathCache, setOverrideReaderForTests } from "../src/state/sandyPath";

let tmp: string;
let mockBinaryPath = "";
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-pathres-test-"));
  mockBinaryPath = "";
  setOverrideReaderForTests(() => mockBinaryPath);
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  setOverrideReaderForTests(undefined);  // restore default reader
  invalidateSandyPathCache();
});

const writeExec = (dir: string, name: string): string => {
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, "#!/bin/sh\necho mock-sandy\n", { mode: 0o755 });
  return f;
};

describe("resolveSandyBinary — explicit override", () => {
  it("uses sandy.binaryPath setting when set and executable", () => {
    const exe = writeExec(tmp, "sandy");
    mockBinaryPath = exe;
    expect(resolveSandyBinary()).toBe(exe);
  });

  // Windows doesn't have a Unix exec-bit — fs.accessSync(file, X_OK) returns
  // success for any readable file; executability is extension-based instead
  // (.exe / .cmd / .bat). The "non-executable file" assertion only makes
  // sense on POSIX. Sandy itself is a bash script that needs WSL on Windows,
  // so the production resolver's Unix-style check is fine for that path too.
  it.skipIf(process.platform === "win32")("returns undefined when override is set but file is non-executable", () => {
    const f = path.join(tmp, "sandy");
    fs.writeFileSync(f, "#!/bin/sh\necho\n");  // no exec bit
    fs.chmodSync(f, 0o644);
    mockBinaryPath = f;
    expect(resolveSandyBinary()).toBeUndefined();
  });

  it("returns undefined when override is set but file doesn't exist", () => {
    mockBinaryPath = path.join(tmp, "no-such-file");
    expect(resolveSandyBinary()).toBeUndefined();
  });
});

describe("resolveSandyBinary — PATH lookup", () => {
  it("finds sandy on PATH when override is unset", () => {
    const exe = writeExec(tmp, "sandy");
    const origPath = process.env.PATH;
    process.env.PATH = tmp;
    try {
      expect(resolveSandyBinary()).toBe(exe);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it("returns undefined when sandy is in no PATH dir AND no common location", () => {
    const origPath = process.env.PATH;
    process.env.PATH = tmp;  // tmp is empty, no sandy
    try {
      expect(resolveSandyBinary()).toBeUndefined();
    } finally {
      process.env.PATH = origPath;
    }
  });

  // Same Windows caveat as the override-non-executable test above — POSIX only.
  it.skipIf(process.platform === "win32")("PATH lookup respects executable bit (skips non-exec entries)", () => {
    const f = path.join(tmp, "sandy");
    fs.writeFileSync(f, "not exec");
    fs.chmodSync(f, 0o644);
    const origPath = process.env.PATH;
    process.env.PATH = tmp;
    try {
      // sandy in PATH but not executable; resolver should NOT pick it up.
      expect(resolveSandyBinary()).toBeUndefined();
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe("resolveSandyBinary — caching", () => {
  it("caches the resolved path across calls within a process", () => {
    const exe = writeExec(tmp, "sandy");
    mockBinaryPath = exe;
    const first = resolveSandyBinary();
    expect(first).toBe(exe);
    // Move/delete the file — cache should still return the original
    fs.rmSync(exe);
    expect(resolveSandyBinary()).toBe(exe);
  });

  it("invalidateSandyPathCache forces re-resolution", () => {
    const exe = writeExec(tmp, "sandy");
    mockBinaryPath = exe;
    expect(resolveSandyBinary()).toBe(exe);
    fs.rmSync(exe);
    invalidateSandyPathCache();
    expect(resolveSandyBinary()).toBeUndefined();
  });
});
