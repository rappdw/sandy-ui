// Compatibility gate (rappdw/sandy-ui#30 / SPEC_SANDY_UI.md §Compatibility).
// Pure logic only — no vscode, no fs, no child_process — so it's cheaply
// unit-testable and reusable from both activation-time and (future)
// launch-time call sites without threading the extension host through it.

// Single source of truth for the declared floor. Keep README.md and
// SPEC_SANDY_UI.md's declaration block in sync with these two consts.
export const SANDY_MIN_VERSION = "1.0.0";
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export type CompatVerdict =
  | { kind: "ok" }
  | { kind: "sandy-missing" }                                       // not on PATH
  | { kind: "too-old"; found: string; min: string }                  // refuse
  | { kind: "schema-too-new"; found: number; supported: number[] }   // soft-warn, best-effort
  | { kind: "schema-unsupported-major"; found: number; supported: number[] }; // refuse

// Parses the first dotted-numeric "x.y.z" token out of a version string,
// tolerating a leading label ("sandy 1.2.0") and a trailing pre-release
// suffix ("1.0.0-rc2" compares as 1.0.0 — pre-release qualifiers don't
// affect the floor check). Same token shape as cache.ts's trySandyVersion.
function parseVersionParts(v: string): [number, number, number] {
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function isBelowMin(found: string, min: string = SANDY_MIN_VERSION): boolean {
  return compareVersions(found, min) < 0;
}

// The gate. schemaVersion is from --print-schema (or --print-state);
// undefined when sandy is missing (or, defensively, when the caller
// couldn't determine it — treated as "nothing to check" rather than
// invented as a failure, since the version-floor check already covers the
// primary "sandy too old" case independent of schema_version).
//
// Rule (spec-aligned, kept simple): supported contains it → ok; == max+1 →
// schema-too-new (warn, best-effort render); > max+1 → schema-unsupported-
// major (refuse). Below sandy_min_version → too-old (refuse) regardless of
// schema_version — an old sandy could theoretically still report schema 1,
// but the version floor is the more actionable signal to surface.
export function evaluateCompat(
  foundVersion: string | undefined,
  schemaVersion: number | undefined,
): CompatVerdict {
  if (!foundVersion) return { kind: "sandy-missing" };
  if (isBelowMin(foundVersion)) {
    return { kind: "too-old", found: foundVersion, min: SANDY_MIN_VERSION };
  }
  if (schemaVersion === undefined) return { kind: "ok" };

  const supported: number[] = [...SUPPORTED_SCHEMA_VERSIONS];
  if (supported.includes(schemaVersion)) return { kind: "ok" };

  const max = Math.max(...supported);
  if (schemaVersion === max + 1) {
    return { kind: "schema-too-new", found: schemaVersion, supported };
  }
  if (schemaVersion > max + 1) {
    return { kind: "schema-unsupported-major", found: schemaVersion, supported };
  }
  // Below the supported range (older schema than sandy-ui has ever known) —
  // not expected in practice since schema versions only move forward, and
  // the additive-change rule means an older schema is a subset of a newer
  // one sandy-ui already renders correctly. Treat as ok rather than
  // inventing a sixth verdict for a case the spec doesn't call out.
  return { kind: "ok" };
}

// Human-facing text for banners/messages. No vscode calls — callers decide
// how to surface (showErrorMessage / showWarningMessage / output channel).
export function describeVerdict(v: CompatVerdict): { severity: "error" | "warning"; message: string } {
  switch (v.kind) {
    case "ok":
      return { severity: "warning", message: "sandy is compatible." };
    case "sandy-missing":
      return { severity: "warning", message: "sandy not found on PATH." };
    case "too-old":
      return {
        severity: "error",
        message: `sandy ${v.found} found — sandy-ui requires sandy ≥ ${v.min}. Update sandy, then reload the window.`,
      };
    case "schema-too-new":
      return {
        severity: "warning",
        message: `sandy's config schema (v${v.found}) is newer than sandy-ui supports (v${v.supported.join(", ")}) — proceeding with best-effort rendering; some fields may not appear. Consider updating the sandy-ui extension.`,
      };
    case "schema-unsupported-major":
      return {
        severity: "error",
        message: `sandy's config schema (v${v.found}) is too far ahead of what sandy-ui supports (v${v.supported.join(", ")}) — update the sandy-ui extension before continuing.`,
      };
  }
}
