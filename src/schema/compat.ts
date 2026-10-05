// Compatibility gate (rappdw/sandy-ui#30 / SPEC_SANDY_UI.md §Compatibility).
// Pure logic only — no vscode, no fs, no child_process — so it's cheaply
// unit-testable and reusable from both activation-time and (future)
// launch-time call sites without threading the extension host through it.

// Single source of truth for the declared floor. Keep README.md and
// SPEC_SANDY_UI.md's declaration block in sync with these consts.
//
// The floor is sandy 2.6.0 / introspection schema 4: what sandy-ui renders and
// is tested against. Schemas 2 and 3 (sandy 2.0–2.5) differ from 4 only in
// handoff/relay fields that sandy-ui never reads, so they render identically
// and are accepted on a best-effort basis. Schema 1 is sandy 1.x, whose
// sandboxes sandy 2.x refuses outright.
export const SANDY_MIN_VERSION = "2.6.0";
export const SUPPORTED_SCHEMA_VERSIONS = [4] as const;
export const BEST_EFFORT_SCHEMA_VERSIONS = [2, 3] as const;

// The sandy major this sandy-ui is built against. sandy's written policy makes
// a schema bump WITHIN a major safe for us — removing an emitted field needs a
// README `## Deprecated` entry announced at that major's .0, or an exception
// that requires every known consumer (sandy-ui is one) to be named and to have
// migrated first. A NEW major can change what a field means with no notice
// (2.0.0 did exactly that with sandboxes[].features), so that case escalates.
export const SUPPORTED_SANDY_MAJOR = 2;

export type CompatVerdict =
  | { kind: "ok" }
  | { kind: "sandy-missing" }                                            // not on PATH
  | { kind: "too-old"; found: string; min: string }                       // sandy 1.x → error
  | { kind: "below-recommended"; found: string; recommended: string }     // 2.0–2.5 → warning
  | { kind: "schema-too-new"; found: number; supported: number[] }        // same major → warning
  | { kind: "new-major"; found: string; major: number };                  // new sandy major → error

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

// The gate. Gates on schema_version first, as sandy recommends: a version
// string is a poor signal (X.Y.Z-dev compares equal to X.Y.Z). The version is
// consulted only for its MAJOR, which is reliable, and as a fallback when the
// schema couldn't be determined.
//
// Nothing here blocks anything. Every verdict becomes at most a notification;
// a genuinely incompatible sandy still reports its own errors at launch.
export function evaluateCompat(
  foundVersion: string | undefined,
  schemaVersion: number | undefined,
): CompatVerdict {
  if (!foundVersion) return { kind: "sandy-missing" };
  // No x.y.z in the string means the major is UNKNOWN, not 0 — reading it as 0
  // would call a schema-4 sandy "too old". Fall through to the schema instead.
  const parsed = /(\d+)\.(\d+)\.(\d+)/.test(foundVersion);
  const major = parsed ? parseVersionParts(foundVersion)[0] : SUPPORTED_SANDY_MAJOR;

  if (major > SUPPORTED_SANDY_MAJOR) {
    return { kind: "new-major", found: foundVersion, major };
  }
  const schemaTooOld = schemaVersion !== undefined
    && schemaVersion < Math.min(...BEST_EFFORT_SCHEMA_VERSIONS, ...SUPPORTED_SCHEMA_VERSIONS);
  if (major < SUPPORTED_SANDY_MAJOR || schemaTooOld) {
    return { kind: "too-old", found: foundVersion, min: SANDY_MIN_VERSION };
  }

  if (schemaVersion !== undefined) {
    const supported: number[] = [...SUPPORTED_SCHEMA_VERSIONS];
    if (supported.includes(schemaVersion)) return { kind: "ok" };
    if ((BEST_EFFORT_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) {
      return { kind: "below-recommended", found: foundVersion, recommended: SANDY_MIN_VERSION };
    }
    if (schemaVersion > Math.max(...supported)) {
      return { kind: "schema-too-new", found: schemaVersion, supported };
    }
  }

  // Schema unknown (or a gap below 4 that isn't listed): fall back to the floor.
  if (parsed && isBelowMin(foundVersion)) {
    return { kind: "below-recommended", found: foundVersion, recommended: SANDY_MIN_VERSION };
  }
  return { kind: "ok" };
}

/**
 * Identity of a notification-worthy compat state, used to show each one ONCE
 * per sandy version rather than on every window activation. The 0.8.2 gate
 * fired on every activation with an instruction the user could not follow;
 * frequency was half of what made that bad.
 */
export function compatNotificationKey(
  foundVersion: string | undefined,
  schemaVersion: number | undefined,
  verdict: CompatVerdict,
): string | undefined {
  if (verdict.kind === "ok" || verdict.kind === "sandy-missing") return undefined;
  // schemaVersion is deliberately NOT part of the key: a transient
  // --print-schema timeout leaves it undefined, and that must not re-notify a
  // state the user has already seen. The verdict kind already reflects it.
  void schemaVersion;
  return `${foundVersion ?? "?"}|${verdict.kind}`;
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
        message: `sandy ${v.found} is too old for this sandy-ui, which needs sandy ${v.min} or later. Update sandy by re-running its installer, then reload the window.`,
      };
    case "below-recommended":
      return {
        severity: "warning",
        message: `sandy ${v.found} is older than the ${v.recommended} this sandy-ui is tested with. It should work; update sandy (sandy --upgrade) for the best experience.`,
      };
    case "schema-too-new":
      return {
        severity: "warning",
        message: `This sandy reports introspection schema v${v.found}, newer than sandy-ui knows (v${v.supported.join(", ")}). sandy-ui keeps working; if something looks wrong, check for a sandy-ui update.`,
      };
    case "new-major":
      return {
        severity: "error",
        message: `sandy ${v.found} is a new major version that this sandy-ui hasn't been tested with, so it may show wrong information. sandy-ui keeps working; check for a sandy-ui update.`,
      };
  }
}
