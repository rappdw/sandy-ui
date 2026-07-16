import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";
import { augmentPath } from "../src/terminal/pty";

// augmentPath splits/joins on the platform's path.delimiter (":" on POSIX,
// ";" on Windows), so the tests build and split their fixtures with it too —
// hardcoding ":" made this whole file fail on the windows-latest CI leg.
const D = path.delimiter;

const HOMEBREW = "/opt/homebrew/bin";
const USR_LOCAL = "/usr/local/bin";
const HOME_LOCAL = path.join(os.homedir(), ".local/bin");
const HOME_BIN = path.join(os.homedir(), "bin");

describe("augmentPath", () => {
  it("appends Homebrew + user-local dirs to a narrow Dock-launchd PATH", () => {
    const dockPath = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(D);
    const result = augmentPath(dockPath).split(D);
    expect(result.slice(0, 4)).toEqual(["/usr/bin", "/bin", "/usr/sbin", "/sbin"]);
    expect(result).toContain(HOMEBREW);
    expect(result).toContain(USR_LOCAL);
    expect(result).toContain(HOME_LOCAL);
    expect(result).toContain(HOME_BIN);
  });

  it("does not duplicate dirs already on PATH", () => {
    const richPath = [HOMEBREW, USR_LOCAL, "/usr/bin"].join(D);
    const result = augmentPath(richPath).split(D);
    const homebrewCount = result.filter(p => p === HOMEBREW).length;
    const usrLocalCount = result.filter(p => p === USR_LOCAL).length;
    expect(homebrewCount).toBe(1);
    expect(usrLocalCount).toBe(1);
  });

  it("preserves user-controlled PATH entries at the front", () => {
    const userPath = ["/Users/me/.cargo/bin", "/usr/bin"].join(D);
    const result = augmentPath(userPath).split(D);
    expect(result[0]).toBe("/Users/me/.cargo/bin");
    expect(result[1]).toBe("/usr/bin");
  });

  it("handles undefined PATH", () => {
    const result = augmentPath(undefined).split(D).filter(Boolean);
    expect(result).toContain(HOMEBREW);
    expect(result).toContain(USR_LOCAL);
  });

  it("handles empty PATH", () => {
    const result = augmentPath("").split(D).filter(Boolean);
    expect(result).toContain(HOMEBREW);
    expect(result).toContain(USR_LOCAL);
  });

  it("filters out empty segments from input", () => {
    const messyPath = `${D}${D}/usr/bin${D}${D}`;
    const result = augmentPath(messyPath).split(D).filter(Boolean);
    expect(result[0]).toBe("/usr/bin");
    expect(result).toContain(HOMEBREW);
  });
});
