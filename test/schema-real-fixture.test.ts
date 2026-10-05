import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { parseSandySchema } from "../src/schema/parse";
import { evaluateCompat } from "../src/schema/compat";
import { FIELD_TYPES } from "../src/schema/types";

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
  });
});
