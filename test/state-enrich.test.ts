import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { enrichWithWorkspaceJson } from "../src/state/enrich";
import type { SandyState, SandySandbox } from "../src/state/types";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-enrich-test-")); });
afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

const writeWorkspaceJson = (sandboxDir: string, content: object) => {
  fs.mkdirSync(sandboxDir, { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, "WORKSPACE.json"), JSON.stringify(content));
};

const sandbox = (overrides: Partial<SandySandbox> = {}): SandySandbox => ({
  name: "test-sandbox",
  path: path.join(tmp, "test-sandbox"),
  workspace_path: undefined as unknown as string,  // intentionally missing for the test
  ...overrides,
});

const state = (sandboxes: SandySandbox[]): SandyState => ({
  schema_version: 1,
  sandboxes,
  approvals: [],
  running_containers: [],
});

describe("enrichWithWorkspaceJson", () => {
  it("recovers workspace_path from {workspace: ...}", () => {
    const sb = sandbox();
    writeWorkspaceJson(sb.path, { workspace: "/Users/x/dev/myproj" });
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBe("/Users/x/dev/myproj");
  });

  it("recovers from {workspace_path: ...} as a fallback name", () => {
    const sb = sandbox();
    writeWorkspaceJson(sb.path, { workspace_path: "/Users/x/dev/other" });
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBe("/Users/x/dev/other");
  });

  it("recovers from {path: ...} as a final fallback", () => {
    const sb = sandbox();
    writeWorkspaceJson(sb.path, { path: "/Users/x/dev/third" });
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBe("/Users/x/dev/third");
  });

  it("prefers 'workspace' over 'workspace_path' when both present", () => {
    const sb = sandbox();
    writeWorkspaceJson(sb.path, { workspace: "/A", workspace_path: "/B" });
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBe("/A");
  });

  it("does NOT overwrite an existing workspace_path", () => {
    const sb = sandbox({ workspace_path: "/already/set" });
    writeWorkspaceJson(sb.path, { workspace: "/Users/x/dev/different" });
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBe("/already/set");
  });

  it("leaves workspace_path missing when WORKSPACE.json doesn't exist", () => {
    const sb = sandbox();
    fs.mkdirSync(sb.path, { recursive: true });  // sandbox dir but no WORKSPACE.json
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBeUndefined();
  });

  it("tolerates malformed WORKSPACE.json without throwing", () => {
    const sb = sandbox();
    fs.mkdirSync(sb.path, { recursive: true });
    fs.writeFileSync(path.join(sb.path, "WORKSPACE.json"), "not valid json {{");
    expect(() => enrichWithWorkspaceJson(state([sb]))).not.toThrow();
    expect(sb.workspace_path).toBeUndefined();
  });

  it("ignores non-string values for the workspace field", () => {
    const sb = sandbox();
    writeWorkspaceJson(sb.path, { workspace: 42, workspace_path: { nested: "x" }, path: "/finally/ok" });
    enrichWithWorkspaceJson(state([sb]));
    expect(sb.workspace_path).toBe("/finally/ok");
  });

  it("processes every sandbox independently", () => {
    const a = sandbox({ name: "a", path: path.join(tmp, "a"), workspace_path: "/already/a" });
    const b = sandbox({ name: "b", path: path.join(tmp, "b") });
    const c = sandbox({ name: "c", path: path.join(tmp, "c") });
    writeWorkspaceJson(b.path, { workspace: "/recovered/b" });
    // c has no WORKSPACE.json
    enrichWithWorkspaceJson(state([a, b, c]));
    expect(a.workspace_path).toBe("/already/a");      // untouched
    expect(b.workspace_path).toBe("/recovered/b");    // recovered
    expect(c.workspace_path).toBeUndefined();          // still missing
  });
});
