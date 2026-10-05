import { describe, it, expect } from "vitest";
import {
  compareVersions,
  isBelowMin,
  evaluateCompat,
  describeVerdict,
  compatNotificationKey,
  SANDY_MIN_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  BEST_EFFORT_SCHEMA_VERSIONS,
  SUPPORTED_SANDY_MAJOR,
} from "../src/schema/compat";

describe("declared floor", () => {
  it("pins the current floor: sandy 2.6.0, schema 4, with 2/3 best-effort, major 2", () => {
    expect(SANDY_MIN_VERSION).toBe("2.6.0");
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([4]);
    expect(BEST_EFFORT_SCHEMA_VERSIONS).toEqual([2, 3]);
    expect(SUPPORTED_SANDY_MAJOR).toBe(2);
  });
});

describe("compareVersions", () => {
  it("orders 0.12.0 below 1.0.0", () => {
    expect(compareVersions("0.12.0", "1.0.0")).toBe(-1);
  });

  it("orders 1.1.0 above 1.0.0", () => {
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
  });

  it("treats equal x.y.z as equal", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("ignores a pre-release suffix — 1.0.0-rc2 compares equal to 1.0.0", () => {
    expect(compareVersions("1.0.0-rc2", "1.0.0")).toBe(0);
  });

  it("tolerates a leading label like 'sandy 1.2.0'", () => {
    expect(compareVersions("sandy 1.2.0", "1.1.0")).toBe(1);
    expect(compareVersions("sandy 1.2.0", "1.2.0")).toBe(0);
  });

  it("compares minor/patch components independently of major", () => {
    expect(compareVersions("1.2.0", "1.10.0")).toBe(-1); // numeric, not lexicographic
    expect(compareVersions("1.0.9", "1.0.10")).toBe(-1);
  });
});

describe("isBelowMin", () => {
  it("is true below the default floor", () => {
    expect(isBelowMin("0.12.0")).toBe(true);
    expect(isBelowMin("2.5.9")).toBe(true);
  });

  it("is false at or above the default floor", () => {
    expect(isBelowMin("2.6.0")).toBe(false);
    expect(isBelowMin("2.7.1")).toBe(false);
  });

  it("honors an explicit min override", () => {
    expect(isBelowMin("1.0.0", "1.1.0")).toBe(true);
    expect(isBelowMin("1.1.0", "1.1.0")).toBe(false);
  });
});

// The gate the 0.8.2 release got wrong: sandy moved schema 1 -> 4 in three
// weeks, only removing fields sandy-ui never reads, and a [1]-only gate put an
// ERROR in front of every user on every window. These pin the replacement.
describe("evaluateCompat", () => {
  it("sandy-missing when foundVersion is undefined", () => {
    expect(evaluateCompat(undefined, undefined)).toEqual({ kind: "sandy-missing" });
    expect(evaluateCompat(undefined, 4)).toEqual({ kind: "sandy-missing" });
  });

  it("current sandy (2.7.1, schema 4) is ok — the regression that shipped in 0.8.2", () => {
    expect(evaluateCompat("2.7.1", 4)).toEqual({ kind: "ok" });
    expect(evaluateCompat("2.8.0-dev", 4)).toEqual({ kind: "ok" });
  });

  it("schemas 2 and 3 (sandy 2.0–2.5) are best-effort: a warning, never an error", () => {
    for (const [v, sv] of [["2.0.0", 2], ["2.2.0", 3], ["2.5.0", 3]] as const) {
      const r = evaluateCompat(v, sv);
      expect(r.kind).toBe("below-recommended");
      expect(describeVerdict(r).severity).toBe("warning");
    }
  });

  it("sandy 1.x is too old — by major, and by schema 1", () => {
    expect(evaluateCompat("1.8.0", 1)).toEqual({ kind: "too-old", found: "1.8.0", min: SANDY_MIN_VERSION });
    expect(evaluateCompat("1.8.0", undefined).kind).toBe("too-old");
    expect(evaluateCompat("0.12.0", undefined).kind).toBe("too-old");
  });

  it("an unknown schema within the same major is a warning (sandy's policy names us first)", () => {
    const r = evaluateCompat("2.9.0", 5);
    expect(r).toEqual({ kind: "schema-too-new", found: 5, supported: [4] });
    expect(describeVerdict(r).severity).toBe("warning");
  });

  it("a new sandy major is an error regardless of schema — it may change field meanings", () => {
    for (const sv of [4, 5, undefined]) {
      const r = evaluateCompat("3.0.0", sv);
      expect(r).toEqual({ kind: "new-major", found: "3.0.0", major: 3 });
      expect(describeVerdict(r).severity).toBe("error");
    }
    // A -dev build of the next major is still the next major.
    expect(evaluateCompat("3.0.0-dev", 4).kind).toBe("new-major");
  });

  it("an unparsable version goes by the schema, never reads as major 0", () => {
    expect(evaluateCompat("unknown", 4)).toEqual({ kind: "ok" });
    expect(evaluateCompat("2.7", 4)).toEqual({ kind: "ok" });
    expect(evaluateCompat("unknown", 3).kind).toBe("below-recommended");
    expect(evaluateCompat("unknown", 1).kind).toBe("too-old");
  });

  it("falls back to the version floor when the schema is unknown", () => {
    expect(evaluateCompat("2.6.0", undefined)).toEqual({ kind: "ok" });
    expect(evaluateCompat("2.3.0", undefined).kind).toBe("below-recommended");
  });
});

describe("describeVerdict", () => {
  it("too-old is an actionable error naming the found version and the floor", () => {
    const d = describeVerdict({ kind: "too-old", found: "1.8.0", min: "2.6.0" });
    expect(d.severity).toBe("error");
    expect(d.message).toContain("1.8.0");
    expect(d.message).toContain("2.6.0");
  });

  it("no message tells the user to update sandy-ui BEFORE continuing — 0.8.2's unfollowable instruction", () => {
    const all = [
      describeVerdict({ kind: "too-old", found: "1.8.0", min: "2.6.0" }),
      describeVerdict({ kind: "below-recommended", found: "2.3.0", recommended: "2.6.0" }),
      describeVerdict({ kind: "schema-too-new", found: 5, supported: [4] }),
      describeVerdict({ kind: "new-major", found: "3.0.0", major: 3 }),
    ];
    for (const d of all) expect(d.message.toLowerCase()).not.toContain("before continuing");
  });

  it("forward-looking verdicts say sandy-ui keeps working", () => {
    expect(describeVerdict({ kind: "schema-too-new", found: 5, supported: [4] }).message).toContain("keeps working");
    expect(describeVerdict({ kind: "new-major", found: "3.0.0", major: 3 }).message).toContain("keeps working");
  });

  it("ok and sandy-missing still return a message (no throw) for exhaustiveness", () => {
    expect(() => describeVerdict({ kind: "ok" })).not.toThrow();
    expect(() => describeVerdict({ kind: "sandy-missing" })).not.toThrow();
  });
});

describe("compatNotificationKey", () => {
  it("is undefined for states that never notify", () => {
    expect(compatNotificationKey("2.7.1", 4, { kind: "ok" })).toBeUndefined();
    expect(compatNotificationKey(undefined, undefined, { kind: "sandy-missing" })).toBeUndefined();
  });

  it("is stable for the same sandy version and verdict, so a state notifies once", () => {
    const v = evaluateCompat("2.3.0", 3);
    expect(compatNotificationKey("2.3.0", 3, v)).toBe(compatNotificationKey("2.3.0", 3, v));
  });

  it("ignores the schema value, so a transient --print-schema timeout doesn't re-notify", () => {
    const v = evaluateCompat("2.3.0", 3);
    expect(compatNotificationKey("2.3.0", 3, v)).toBe(compatNotificationKey("2.3.0", undefined, v));
  });

  it("changes when sandy's version or the verdict changes, so a new state does notify", () => {
    const a = compatNotificationKey("2.3.0", 3, evaluateCompat("2.3.0", 3));
    const b = compatNotificationKey("2.4.0", 3, evaluateCompat("2.4.0", 3));
    const c = compatNotificationKey("3.0.0", 4, evaluateCompat("3.0.0", 4));
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
