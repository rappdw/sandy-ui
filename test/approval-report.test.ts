import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { asApprovalsReport, buildPreview, startedWithout, refusedSymlinks, looksSecret, ApprovalsReport, KeyValueSource } from "../src/approval/report";
import { workspaceValues } from "../src/approval/approvals";

// Shapes from sandy's SPEC_INTROSPECTION.md "--approvals" (2.7.0, #296).
const gates = (over: Partial<Record<"keys" | "sym" | "df", object>> = {}) => [
  { gate: "passive_privileged", status: "approved", keys: [], sources: [], if_unanswered: "keys_dropped", ...over.keys },
  { gate: "symlinks", status: "not_applicable", symlinks: [], new: [], if_unanswered: "launch_refused", ...over.sym },
  { gate: "dockerfile", status: "not_applicable", context_files: [], session_created: false, if_unanswered: "base_image", ...over.df },
];
const report = (unresolved: string[], over = {}): ApprovalsReport =>
  asApprovalsReport({ schema_version: 4, workspace: "/w", complete: true, error: null, unresolved, gates: gates(over) })!;
const values = (kv: Record<string, string>, secretFile: string[] = []) => (k: string): KeyValueSource =>
  k in kv ? { value: kv[k], file: secretFile.includes(k) ? ".sandy/.secrets" : ".sandy/config", secret: secretFile.includes(k) || looksSecret(k) } : { secret: false };

describe("asApprovalsReport", () => {
  it("rejects anything without a boolean complete", () => {
    expect(asApprovalsReport(null)).toBeUndefined();
    expect(asApprovalsReport({ gates: [] })).toBeUndefined();
  });
  it("tolerates missing arrays", () => {
    expect(asApprovalsReport({ complete: false, error: "bad" })).toMatchObject({ complete: false, unresolved: [], gates: [], error: "bad" });
  });
});

describe("buildPreview", () => {
  it("shows nothing when nothing is unresolved, or there's no verdict", () => {
    expect(buildPreview(report([]), values({}))).toBeUndefined();
    expect(buildPreview(asApprovalsReport({ complete: false, unresolved: ["dockerfile"], gates: [] }), values({}))).toBeUndefined();
    expect(buildPreview(undefined, values({}))).toBeUndefined();
  });

  it("lists pending privileged keys WITH values, masking credentials", () => {
    const p = buildPreview(
      report(["passive_privileged"], { keys: { status: "pending", keys: ["SANDY_ALLOW_HOSTS", "ANTHROPIC_API_KEY", "SANDY_SSH"] } }),
      values({ SANDY_ALLOW_HOSTS: "evil.example.com", ANTHROPIC_API_KEY: "sk-live-123", SANDY_SSH: "agent" }, ["SANDY_SSH"]),
    )!;
    expect(p.willRefuse).toBe(false);
    expect(p.body).toContain("SANDY_ALLOW_HOSTS=evil.example.com");
    expect(p.body).not.toContain("sk-live-123");
    expect(p.body).toContain("ANTHROPIC_API_KEY=••••••••");
    expect(p.body).toContain("SANDY_SSH=••••••••  (hidden; set in .sandy/.secrets)");
    expect(p.header).toMatch(/ask for approval in the terminal/);
  });

  it("says when approved settings changed, and names a key with no value", () => {
    const p = buildPreview(
      report(["passive_privileged"], { keys: { status: "changed", approved_at: "2026-04-15T10:00:00Z", keys: ["SANDY_SSH"] } }),
      values({}),
    )!;
    expect(p.body).toContain("changed since you approved them (2026-04-15T10:00:00Z)");
    expect(p.body).toContain("SANDY_SSH  (value not found");
  });

  it("lists the Dockerfile and its build context, and flags a .sandy/ a session created", () => {
    const p = buildPreview(report(["dockerfile"], {
      df: { status: "pending", dockerfile: "/w/.sandy/Dockerfile", context_files: ["Dockerfile", "setup.sh"], session_created: true },
    }), values({}))!;
    expect(p.body).toContain("/w/.sandy/Dockerfile");
    expect(p.body).toContain("build context: setup.sh");
    expect(p.body).toContain("a sandy session created this .sandy/");
  });

  it("warns that refused symlinks will stop the launch", () => {
    const p = buildPreview(report(["symlinks"], { sym: { status: "refused", new: ["data -> /etc"] } }), values({}))!;
    expect(p.willRefuse).toBe(true);
    expect(p.header).toMatch(/refuse to start/);
    expect(p.body).toContain("data -> /etc");
  });

  it("renders hostile values verbatim — the webview shows them as text", () => {
    const p = buildPreview(report(["passive_privileged"], { keys: { status: "pending", keys: ["SANDY_ALLOW_HOSTS"] } }),
      values({ SANDY_ALLOW_HOSTS: `<script>alert(1)</script>&"x"` }))!;
    expect(p.body).toContain(`SANDY_ALLOW_HOSTS=<script>alert(1)</script>&"x"`);
  });
});

describe("startedWithout / refusedSymlinks", () => {
  it("names what a started session is running without", () => {
    expect(startedWithout(report([]))).toEqual([]);
    expect(startedWithout(report(["passive_privileged", "dockerfile"], { keys: { status: "pending", keys: ["SANDY_SSH"] }, df: { status: "changed" } })))
      .toEqual(["privileged settings SANDY_SSH", "the project Dockerfile (running the base image)"]);
    expect(startedWithout(asApprovalsReport({ complete: false, unresolved: ["dockerfile"], gates: [] }))).toEqual([]);
  });
  it("returns the refused symlinks only when the symlink gate refused", () => {
    expect(refusedSymlinks(report(["symlinks"], { sym: { status: "refused", new: ["a -> /b"] } }))).toEqual(["a -> /b"]);
    expect(refusedSymlinks(report([]))).toEqual([]);
  });
});

describe("workspaceValues", () => {
  it("reads values as sandy does, .secrets winning, and marks .secrets values secret", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-approvals-"));
    try {
      fs.mkdirSync(path.join(ws, ".sandy"));
      fs.writeFileSync(path.join(ws, ".sandy", "config"), 'SANDY_ALLOW_HOSTS="a.example"\nSANDY_SSH=token\n');
      fs.writeFileSync(path.join(ws, ".sandy", ".secrets"), "SANDY_SSH=agent\n");
      const v = workspaceValues(ws);
      expect(v("SANDY_ALLOW_HOSTS")).toEqual({ value: "a.example", file: ".sandy/config", secret: false });
      expect(v("SANDY_SSH")).toEqual({ value: "agent", file: ".sandy/.secrets", secret: true });
      expect(v("MISSING_TOKEN")).toEqual({ secret: true });
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });
});
