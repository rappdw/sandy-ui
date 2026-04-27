import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { deleteSandboxDir } from "../src/state/deleteSandbox";

let tmp: string;
let sandboxesRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-delete-test-"));
  sandboxesRoot = path.join(tmp, "sandboxes");
  fs.mkdirSync(sandboxesRoot);
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const writeSandbox = (name: string, files: Record<string, string> = {}) => {
  const dir = path.join(sandboxesRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, n), content);
  }
  return dir;
};

describe("deleteSandboxDir — happy path", () => {
  it("removes a sandbox directory and all its contents", () => {
    const dir = writeSandbox("myproj-abc12345", {
      "WORKSPACE.json": `{"workspace_path":"/Users/x/dev/myproj"}`,
      "Dockerfile": "FROM scratch",
    });
    const result = deleteSandboxDir(dir, sandboxesRoot);
    expect(result.ok).toBe(true);
    expect(result.removedPath).toBe(path.resolve(dir));
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes nested subdirectories recursively", () => {
    const dir = writeSandbox("nested-test");
    fs.mkdirSync(path.join(dir, "deep", "nested", "tree"), { recursive: true });
    fs.writeFileSync(path.join(dir, "deep", "nested", "tree", "file.txt"), "content");
    expect(deleteSandboxDir(dir, sandboxesRoot).ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("deleteSandboxDir — refuses paths outside sandboxesRoot", () => {
  it("refuses an absolute path outside the root", () => {
    const elsewhere = path.join(tmp, "not-a-sandbox");
    fs.mkdirSync(elsewhere);
    const result = deleteSandboxDir(elsewhere, sandboxesRoot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to delete/);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it("refuses a parent-traversal attempt (../../..)", () => {
    const escape = path.join(sandboxesRoot, "..", "..", "victim");
    fs.mkdirSync(path.resolve(escape), { recursive: true });
    const result = deleteSandboxDir(escape, sandboxesRoot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to delete/);
    expect(fs.existsSync(path.resolve(escape))).toBe(true);
    fs.rmSync(path.resolve(escape), { recursive: true, force: true });  // test cleanup
  });

  it("refuses the sandboxes root itself", () => {
    const result = deleteSandboxDir(sandboxesRoot, sandboxesRoot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to delete/);
    expect(fs.existsSync(sandboxesRoot)).toBe(true);
  });

  it("refuses '/'", () => {
    const result = deleteSandboxDir("/", sandboxesRoot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to delete/);
  });
});

describe("deleteSandboxDir — input validation", () => {
  it("returns error for empty path", () => {
    const result = deleteSandboxDir("", sandboxesRoot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no path provided/);
  });

  it("returns error when path doesn't exist", () => {
    const ghost = path.join(sandboxesRoot, "does-not-exist");
    const result = deleteSandboxDir(ghost, sandboxesRoot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });
});
