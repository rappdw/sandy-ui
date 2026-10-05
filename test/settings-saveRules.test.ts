import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { boolChecked, displayValue, serialize, baselineValue, enumOptions } from "../media/settings/src/saveRules";
import { parseSandySchema } from "../src/schema/parse";

// The settings form sends a key only when its value differs from its baseline:
// what the control shows when rendered from the FILE alone. 0.8.3's first draft
// rendered all 62 sandy 2.7.1 fields and the save path wrote every one of them,
// so a single Save would have written SANDY_RELAY=false (sandy >= 2.6.0 refuses
// that key at any value — every later launch fails) and
// SANDY_CROSS_SESSION_INBOUND=accept (the first option of a select with no
// default). These pin the rules that prevent that.
const schema = parseSandySchema(JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "sandy-2.7.1-print-schema.json"), "utf8"),
));
const byKey = new Map(schema.fields.map((f) => [f.key, f]));
const field = (k: string) => { const f = byKey.get(k); if (!f) throw new Error(`no field ${k}`); return f; };

describe("baselineValue on real sandy 2.7.1 fields", () => {
  it("an unset enum with no default has an empty baseline, not its first option", () => {
    expect(baselineValue(field("SANDY_CROSS_SESSION_INBOUND"), undefined)).toBe("");
    expect(baselineValue(field("SANDY_EFFORT"), undefined)).toBe("");
  });

  it("an unset bool with no default has baseline false", () => {
    expect(baselineValue(field("SANDY_RELAY"), undefined)).toBe("false");
  });

  it("a stored value is its own baseline, so an untouched stored key is not re-sent", () => {
    expect(baselineValue(field("SANDY_EFFORT"), "high")).toBe("high");
    expect(baselineValue(field("SANDY_RELAY"), "true")).toBe("true");
  });
});

describe("deprecated keys", () => {
  it("parse passes stability through, and SANDY_RELAY is deprecated", () => {
    expect(field("SANDY_RELAY").stability).toBe("deprecated");
    expect(field("SANDY_EFFORT").stability).toBe("stable");
  });
});

describe("enumOptions", () => {
  const f = { key: "SANDY_EFFORT", type: "enum", options: ["low", "medium", "high"] };

  it("leads with a (sandy default) option whose value is empty", () => {
    expect(enumOptions(f, "")[0]).toEqual({ value: "", label: "(sandy default)" });
  });

  it("names the schema default in that option when there is one", () => {
    expect(enumOptions({ ...f, default: "medium" }, "")[0].label).toBe("(sandy default: medium)");
  });

  it("keeps a stored value sandy no longer lists, so Save can't silently clear it", () => {
    const opts = enumOptions(f, "ultra");
    expect(opts.map((o) => o.value)).toContain("ultra");
    expect(baselineValue(f, "ultra")).toBe("ultra");
  });
});

describe("serialize / displayValue", () => {
  it("bool accepts every stored truthy form", () => {
    for (const v of ["true", "1", true]) expect(boolChecked(v)).toBe(true);
    for (const v of ["false", "0", "", undefined, null, false]) expect(boolChecked(v)).toBe(false);
  });

  it("enums ignore the schema default; other types pre-fill it", () => {
    expect(displayValue({ key: "E", type: "enum", default: "high" }, undefined)).toBe("");
    expect(displayValue({ key: "N", type: "int", default: 128000 }, undefined)).toBe(128000);
    expect(serialize({ key: "N", type: "int" }, 128000)).toBe("128000");
  });

  it("agent_combo serializes in option order and drops unknowns, matching collect()", () => {
    const f = { key: "SANDY_AGENT", type: "agent_combo", options: ["claude", "codex", "gemini"] };
    expect(serialize(f, "gemini,claude,bogus")).toBe("claude,gemini");
    expect(baselineValue(f, "gemini,claude")).toBe("claude,gemini");
  });
});
