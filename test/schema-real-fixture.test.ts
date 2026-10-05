import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseSandySchema } from "../src/schema/parse";
import { evaluateCompat } from "../src/schema/compat";
import { FIELD_TYPES } from "../src/schema/types";
import { partitionByTier } from "../src/settings/configIO";

// Real `sandy --print-schema` output from sandy v2.7.1 (schema_version 4),
// captured 2026-10-02. 0.8.2 shipped two bugs against exactly this document: the
// compat gate errored on schema 4, and the settings form threw on its new `path`
// field type and silently hid 46 of 62 fields. Pin both against the real thing.
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sandy-2.7.1-print-schema.json"), "utf8"));

describe("real sandy 2.7.1 --print-schema", () => {
  it("is the document we think it is", () => {
    expect(raw.schema_version).toBe(4);
    expect(raw.sandy.version).toBe("2.7.1");
  });

  it("parses every config key into a field with a key and a type", () => {
    const s = parseSandySchema(raw);
    expect(s.fields.length).toBe(62);
    expect(s.fields.every((f) => f.key && f.type)).toBe(true);
    expect(s.capabilities?.daemonMode).toBe(true);
    expect(s.capabilities?.approvalsReport).toBe(true);
    expect(s.capabilities?.updateSessions).toBe(true);
  });

  it("routes only secret-type keys to .secrets — none of the 16 privileged non-secrets (#53)", () => {
    const s = parseSandySchema(raw);
    const schema = { ...s };
    const all = Object.fromEntries(s.fields.map((f) => [f.key, "x"]));
    const { secrets } = partitionByTier(schema, all);
    const secretTyped = s.fields.filter((f) => f.type === "secret").map((f) => f.key).sort();
    expect(Object.keys(secrets).sort()).toEqual(secretTyped);
    for (const k of ["SANDY_ALLOW_NO_ISOLATION", "SANDY_SKIP_PERMISSIONS", "SANDY_ALLOW_HOSTS", "SANDY_SSH", "SANDY_EXTRA_ENV"]) {
      expect(secrets[k], k).toBeUndefined();
    }
    expect(s.fields.filter((f) => f.tier === "secrets" && f.type !== "secret")).toEqual([]);
  });

  it("passes the compat gate cleanly", () => {
    expect(evaluateCompat(raw.sandy.version, raw.schema_version)).toEqual({ kind: "ok" });
  });

  it("uses only field types sandy-ui renders explicitly", () => {
    const emitted = new Set<string>();
    for (const tier of ["privileged_keys", "passive_keys"]) {
      for (const k of raw.config[tier] ?? []) emitted.add(k.type);
    }
    const unknown = [...emitted].filter((t) => !(FIELD_TYPES as readonly string[]).includes(t));
    expect(unknown).toEqual([]);
  });

  it("the settings webview's FieldDef union lists exactly FIELD_TYPES", () => {
    // Host and webview share no files by design, so the webview keeps its own
    // literal union. Its `never` check enforces a case per listed type; this
    // check enforces that the list itself matches the host's.
    const src = fs.readFileSync(path.join(__dirname, "..", "media", "settings", "src", "settings.ts"), "utf8");
    const m = src.match(/interface FieldDef \{[\s\S]*?\n\s*type: ([^;]+);/);
    expect(m, "FieldDef.type union not found").toBeTruthy();
    const webview = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    expect(webview).toEqual([...FIELD_TYPES].sort());
    // …and so does KNOWN_TYPES, which decides when to fall back to base_type.
    const k = src.match(/const KNOWN_TYPES[^=]*= new Set\(\[([^\]]+)\]\)/);
    expect(k, "KNOWN_TYPES not found").toBeTruthy();
    expect([...k![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort()).toEqual([...FIELD_TYPES].sort());
  });
});

// sandy main after #440 (f585240, 2.8.0-dev): adds base_type to every config
// key and documents the closed set of types. The seed of the nightly contract
// check sandy's maintainer asked consumers to own (Decision 4).
describe("real sandy main (f585240) --print-schema", () => {
  const main = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "sandy-2.8.0-dev-f585240-print-schema.json"), "utf8"));

  it("parses, passes the gate, and every type is one sandy-ui renders", () => {
    const s = parseSandySchema(main);
    expect(evaluateCompat(main.sandy.version, main.schema_version)).toEqual({ kind: "ok" });
    for (const f of s.fields) expect(FIELD_TYPES as readonly string[], f.key).toContain(f.type);
    expect(s.capabilities).toEqual({ daemonMode: true, approvalsReport: true, updateSessions: true });
  });

  it("passes base_type through, and it agrees with how sandy-ui stores each type", () => {
    const s = parseSandySchema(main);
    const expected: Record<string, string> = { bool: "bool", int: "int", string: "string", path: "string", enum: "string", secret: "string", agent_combo: "string" };
    for (const f of s.fields) expect(f.baseType, f.key).toBe(expected[f.type]);
  });
});
