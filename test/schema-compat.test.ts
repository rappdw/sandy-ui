import { describe, it, expect } from "vitest";
import {
  compareVersions,
  isBelowMin,
  evaluateCompat,
  describeVerdict,
  SANDY_MIN_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
} from "../src/schema/compat";

describe("declared floor", () => {
  it("pins the current min version and supported schema list", () => {
    expect(SANDY_MIN_VERSION).toBe("1.0.0");
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual([1]);
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
  });

  it("is false at or above the default floor", () => {
    expect(isBelowMin("1.0.0")).toBe(false);
    expect(isBelowMin("1.1.0")).toBe(false);
  });

  it("honors an explicit min override", () => {
    expect(isBelowMin("1.0.0", "1.1.0")).toBe(true);
    expect(isBelowMin("1.1.0", "1.1.0")).toBe(false);
  });
});

describe("evaluateCompat", () => {
  it("sandy-missing when foundVersion is undefined", () => {
    expect(evaluateCompat(undefined, undefined)).toEqual({ kind: "sandy-missing" });
    // Even a present schema_version can't happen without a version, but the
    // gate should still short-circuit on missing sandy rather than guess.
    expect(evaluateCompat(undefined, 1)).toEqual({ kind: "sandy-missing" });
  });

  it("too-old when below the min version, regardless of schema_version", () => {
    expect(evaluateCompat("0.12.0", 1)).toEqual({
      kind: "too-old",
      found: "0.12.0",
      min: SANDY_MIN_VERSION,
    });
    expect(evaluateCompat("0.9.0", undefined)).toEqual({
      kind: "too-old",
      found: "0.9.0",
      min: SANDY_MIN_VERSION,
    });
  });

  it("ok when schema_version is undefined but sandy is at/above the floor", () => {
    expect(evaluateCompat("1.0.0", undefined)).toEqual({ kind: "ok" });
  });

  describe("boundary at supported=[1]", () => {
    it("schema 1 → ok", () => {
      expect(evaluateCompat("1.0.0", 1)).toEqual({ kind: "ok" });
    });

    it("schema 2 (max+1) → schema-too-new (warn)", () => {
      expect(evaluateCompat("1.0.0", 2)).toEqual({
        kind: "schema-too-new",
        found: 2,
        supported: [1],
      });
    });

    it("schema 3 (> max+1) → schema-unsupported-major (refuse)", () => {
      expect(evaluateCompat("1.0.0", 3)).toEqual({
        kind: "schema-unsupported-major",
        found: 3,
        supported: [1],
      });
    });
  });

  it("a newer sandy within the supported schema is the normal case — ok", () => {
    expect(evaluateCompat("1.5.2", 1)).toEqual({ kind: "ok" });
  });
});

describe("describeVerdict", () => {
  it("too-old is an actionable error mentioning found + min version", () => {
    const d = describeVerdict({ kind: "too-old", found: "0.12.0", min: "1.0.0" });
    expect(d.severity).toBe("error");
    expect(d.message).toContain("0.12.0");
    expect(d.message).toContain("1.0.0");
  });

  it("schema-too-new is a warning, not an error", () => {
    const d = describeVerdict({ kind: "schema-too-new", found: 2, supported: [1] });
    expect(d.severity).toBe("warning");
    expect(d.message).toContain("2");
  });

  it("schema-unsupported-major is an actionable error", () => {
    const d = describeVerdict({ kind: "schema-unsupported-major", found: 3, supported: [1] });
    expect(d.severity).toBe("error");
    expect(d.message).toContain("3");
  });

  it("ok and sandy-missing still return a message (no throw) for exhaustiveness", () => {
    expect(() => describeVerdict({ kind: "ok" })).not.toThrow();
    expect(() => describeVerdict({ kind: "sandy-missing" })).not.toThrow();
  });
});
