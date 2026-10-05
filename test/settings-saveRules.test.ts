import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { agentBoxes, agentComboValue, boolChecked, boolEncoding, boolUnrecognized, displayValue, serialize, baselineValue, enumOptions } from "../media/settings/src/saveRules";
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

  it("an unset bool's baseline is its default, in the key's own spelling", () => {
    expect(baselineValue(field("SANDY_OFFLINE"), undefined)).toBe("0");
    expect(baselineValue(field("SANDY_SKIP_PERMISSIONS"), undefined)).toBe("true");
    expect(baselineValue(field("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"), undefined)).toBe("0");
  });

  it("a stored value is its own baseline, so an untouched stored key is not re-sent", () => {
    expect(baselineValue(field("SANDY_EFFORT"), "high")).toBe("high");
    expect(baselineValue(field("SANDY_OFFLINE"), "1")).toBe("1");
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
  it("a bool is checked only by its own key's 'on' spelling", () => {
    const digits = field("SANDY_ALLOW_NO_ISOLATION"), words = field("SANDY_SKIP_PERMISSIONS");
    expect(boolChecked(digits, "1")).toBe(true);
    // sandy tests `= 1`: "true" here is OFF, and the form must not claim otherwise.
    for (const v of ["true", "0", "", undefined, null, false]) expect(boolChecked(digits, v)).toBe(false);
    expect(boolChecked(words, "true")).toBe(true);
    for (const v of ["1", "false", ""]) expect(boolChecked(words, v)).toBe(false);
    expect(boolUnrecognized(digits, "true")).toBe(true);
    expect(boolUnrecognized(digits, "0")).toBe(false);
    expect(boolUnrecognized(digits, undefined)).toBe(false);
  });

  it("enums ignore the schema default; other types pre-fill it", () => {
    expect(displayValue({ key: "E", type: "enum", default: "high" }, undefined)).toBe("");
    expect(displayValue({ key: "N", type: "int", default: 128000 }, undefined)).toBe(128000);
    expect(serialize({ key: "N", type: "int" }, 128000)).toBe("128000");
  });

  it("agent_combo keeps sandy's order (first = primary) and values that aren't listed agents", () => {
    const f = { key: "SANDY_AGENT", type: "agent_combo", options: ["claude", "codex", "gemini"] };
    expect(serialize(f, "gemini, claude,all,gemini")).toBe("gemini,claude,all");
    expect(baselineValue(f, "gemini,claude")).toBe("gemini,claude");
  });
});

// ---- State sequences (#53) --------------------------------------------------
// The webview is a browser IIFE with no DOM test environment, so these drive
// the same pure transitions it uses: render rows from state, pick what Save
// sends, apply the host's ack.
import { pickChanged, applySavedAck, ingestHostScope, type FormScope, type FormRow } from "../media/settings/src/saveRules";

const isSecret = (k: string) => byKey.get(k)?.type === "secret";
const empty = (): FormScope => ({ values: {}, form: {}, secretsPresent: {}, clearPending: [], misplaced: [] });
/** Rows as rendered from state, with the user's control values overriding. */
function rows(s: FormScope, controls: Record<string, string>): FormRow[] {
  return Object.keys({ ...controls, ...s.form }).map((k) => {
    const f = field(k);
    const shown = k in controls ? controls[k] : s.form[k];
    return { key: k, value: shown, baseline: f.type === "secret" ? undefined : baselineValue(f, s.values[k]) };
  });
}
const host = (values: Record<string, string>, secretsPresent: Record<string, boolean> = {}) => ({ values, secretsPresent });

describe("save state sequences", () => {
  it("toggle off → save → ack → toggle back on → save sends the key (stale-baseline bug)", () => {
    // SANDY_SKIP_PERMISSIONS defaults to true, so an unset file shows it on.
    let s = empty();
    const sent1 = pickChanged(rows(s, { SANDY_SKIP_PERMISSIONS: "false" }));
    expect(sent1).toEqual({ SANDY_SKIP_PERMISSIONS: "false" });
    s.form = sent1;
    s = applySavedAck(s, { values: sent1, clearSecrets: [] }, host({ SANDY_SKIP_PERMISSIONS: "false" }), isSecret);
    expect(s.form).toEqual({});
    // Back on: equal to the schema default, but NOT to the file — must be sent.
    const sent2 = pickChanged(rows(s, { SANDY_SKIP_PERMISSIONS: "true" }));
    expect(sent2).toEqual({ SANDY_SKIP_PERMISSIONS: "true" });
  });

  it("the same sequence works when the ack carries no read-back", () => {
    let s = empty();
    const sent1 = { SANDY_SKIP_PERMISSIONS: "false" };
    s.form = sent1;
    s = applySavedAck(s, { values: sent1, clearSecrets: [] }, {}, isSecret);
    expect(s.values).toEqual({ SANDY_SKIP_PERMISSIONS: "false" });
    expect(pickChanged(rows(s, { SANDY_SKIP_PERMISSIONS: "true" }))).toEqual({ SANDY_SKIP_PERMISSIONS: "true" });
  });

  it("an untouched form sends nothing", () => {
    const s = ingestHostScope(empty(), host({ SANDY_SKIP_PERMISSIONS: "true", SANDY_MODEL: "claude" }));
    expect(pickChanged(rows(s, { SANDY_SKIP_PERMISSIONS: "true", SANDY_MODEL: "claude" }))).toEqual({});
  });

  it("a draft survives an external file edit plus hide/show", () => {
    let s = ingestHostScope(empty(), host({ SANDY_MODEL: "claude" }));
    s.form = { SANDY_MODEL: "codex" };
    // File edited elsewhere (another key changed), then the panel is re-shown.
    s = ingestHostScope(s, host({ SANDY_MODEL: "claude", SANDY_SKIP_PERMISSIONS: "false" }));
    expect(s.form).toEqual({ SANDY_MODEL: "codex" });
    expect(s.values.SANDY_SKIP_PERMISSIONS).toBe("false");
    // Save sends the draft and nothing for the externally edited key.
    expect(pickChanged(rows(s, { SANDY_SKIP_PERMISSIONS: "false" }))).toEqual({ SANDY_MODEL: "codex" });
  });

  it("an edit made while the save is in flight survives the ack", () => {
    let s = empty();
    const sent = { SANDY_MODEL: "codex" };
    // During the save: the user changes another key, and re-edits the sent one.
    s.form = { SANDY_MODEL: "gemini", SANDY_SKIP_PERMISSIONS: "true" };
    s = applySavedAck(s, { values: sent, clearSecrets: [] }, host({ SANDY_MODEL: "codex" }), isSecret);
    expect(s.form).toEqual({ SANDY_MODEL: "gemini", SANDY_SKIP_PERMISSIONS: "true" });
  });

  it("an edit back to the OLD file value during the save is kept (pinned), and sent next", () => {
    let s = ingestHostScope(empty(), host({ SANDY_MODEL: "claude" }));
    const sent = { SANDY_MODEL: "codex" };
    // Without pinning, "claude" equals the pre-save baseline and is dropped.
    expect(pickChanged(rows(s, { SANDY_MODEL: "claude" }))).toEqual({});
    s.form = pickChanged(rows(s, { SANDY_MODEL: "claude" }), new Set(Object.keys(sent)));
    s = applySavedAck(s, { values: sent, clearSecrets: [] }, host({ SANDY_MODEL: "codex" }), isSecret);
    expect(s.form).toEqual({ SANDY_MODEL: "claude" });
    expect(pickChanged(rows(s, {}))).toEqual({ SANDY_MODEL: "claude" });
  });

  it("a typed secret and a clear mark made during the save survive the ack", () => {
    let s = ingestHostScope(empty(), host({}, { ANTHROPIC_API_KEY: true, OPENAI_API_KEY: true }));
    s.form = { GEMINI_API_KEY: "typed-later" };
    s.clearPending = ["OPENAI_API_KEY"];
    s = applySavedAck(s, { values: { SANDY_MODEL: "codex" }, clearSecrets: [] },
      host({ SANDY_MODEL: "codex" }, { ANTHROPIC_API_KEY: true, OPENAI_API_KEY: true }), isSecret);
    expect(s.form).toEqual({ GEMINI_API_KEY: "typed-later" });
    expect(s.clearPending).toEqual(["OPENAI_API_KEY"]);
  });

  it("a clear that was sent is dropped from the marks once the ack confirms it", () => {
    let s = ingestHostScope(empty(), host({}, { OPENAI_API_KEY: true }));
    s.clearPending = ["OPENAI_API_KEY"];
    s = applySavedAck(s, { values: {}, clearSecrets: ["OPENAI_API_KEY"] }, host({}, {}), isSecret);
    expect(s.clearPending).toEqual([]);
    expect(s.secretsPresent).toEqual({});
  });

  it("secrets are always sent when typed and never compared against a baseline", () => {
    expect(pickChanged(rows(empty(), { ANTHROPIC_API_KEY: "sk" }))).toEqual({ ANTHROPIC_API_KEY: "sk" });
  });
});


// sandy-ui <= 0.8.3 wrote every bool as true/false. sandy reads most of them as
// 0/1, and SANDY_OFFLINE / SANDY_SUSPICIOUS exit on anything else — so one
// toggle could stop every launch.
describe("bool spelling per key", () => {
  it("writes 0/1 for the keys sandy reads as 0/1, and true/false for SANDY_SKIP_PERMISSIONS", () => {
    for (const k of ["SANDY_OFFLINE", "SANDY_SUSPICIOUS", "SANDY_ALLOW_NO_ISOLATION", "SANDY_EGRESS_STRICT",
      "SANDY_VENV_OVERLAY", "SANDY_TOOL_AUDIT", "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS"]) {
      expect(serialize(field(k), true), k).toBe("1");
      expect(serialize(field(k), false), k).toBe("0");
    }
    expect(serialize(field("SANDY_SKIP_PERMISSIONS"), false)).toBe("false");
  });

  it("every bool sandy 2.7.1 declares has a known spelling: a 0/1 or true/false default, or a listed exception", () => {
    // A new sandy bool with no default would silently get 0/1. Fail here so
    // someone checks how sandy actually reads it and lists it in saveRules.ts.
    const known = new Set(["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "GOOGLE_GENAI_USE_VERTEXAI"]);
    for (const f of schema.fields) {
      if (f.type !== "bool" || f.stability === "deprecated") continue;
      const d = f.default;
      const ok = d === "0" || d === "1" || d === "true" || d === "false" || known.has(f.key);
      expect(ok, `${f.key} default=${String(d)}`).toBe(true);
      expect(["1", "true"]).toContain(boolEncoding(f).on);
    }
  });
});


// sandy-ui#52: SANDY_AGENT's list comes from the schema's top-level `agents`,
// and sandy reads its order (first agent = primary, pane layout).
describe("SANDY_AGENT", () => {
  it("gets the five agents from sandy 2.7.1's top-level agents list", () => {
    expect(field("SANDY_AGENT").options).toEqual(["claude", "gemini", "codex", "opencode", "grok"]);
  });

  it("draws a box for a stored value that isn't a listed agent, so it can be seen and unchecked", () => {
    expect(agentBoxes(["claude", "codex"], "codex,all")).toEqual([
      { value: "claude", listed: true }, { value: "codex", listed: true }, { value: "all", listed: false },
    ]);
  });

  it("keeps the stored order, and appends newly checked agents", () => {
    // Boxes are in option order; the stored order wins for boxes still checked.
    expect(agentComboValue("codex,claude", ["claude", "codex"])).toBe("codex,claude");
    expect(agentComboValue("codex,claude", ["claude", "codex", "gemini"])).toBe("codex,claude,gemini");
    expect(agentComboValue("codex,claude", ["claude"])).toBe("claude");
    expect(agentComboValue("", ["gemini", "claude"])).toBe("gemini,claude");
    expect(agentComboValue("claude,all", ["claude"])).toBe("claude");
  });

  it("an untouched group matches its baseline, so it is never sent", () => {
    for (const stored of ["codex,claude", "claude", " codex , claude ", "all"]) {
      const f = field("SANDY_AGENT");
      const checked = agentBoxes(f.options ?? [], stored).map((b) => b.value).filter((v) => stored.includes(v));
      expect(agentComboValue(stored, checked), stored).toBe(baselineValue(f, stored));
    }
  });
});
