// What the settings form shows, and what it is allowed to write.
//
// DOM-free so vitest can import it (settings.ts is a browser IIFE). Render and
// save both go through these functions, so what a control displays and what
// the save path compares it against cannot drift apart.
//
// The rule that matters: the form writes a key ONLY when its value differs
// from what the file would display. The host's save merges into the existing
// file and keeps every key it isn't sent, so skipping an untouched key is
// always safe. Writing every rendered key was not: with the full sandy 2.x
// schema rendered, one Save wrote `SANDY_RELAY=false` (a key sandy >= 2.6.0
// refuses at ANY value, so every later launch failed),
// `SANDY_CROSS_SESSION_INBOUND=accept` (just the first option of a select with
// no default), and pinned dozens of sandy defaults into the user's config.

export {};

export interface RuleField {
  key: string;
  type: string;
  default?: unknown;
  options?: string[];
}

// sandy has two spellings for bools, and each key reads only its own. Most
// test `= 1` / `!= 0` and SANDY_OFFLINE and SANDY_SUSPICIOUS EXIT on anything
// but 0/1; SANDY_SKIP_PERMISSIONS alone tests `= "true"`. Writing true/false
// everywhere (sandy-ui <= 0.8.3) left SANDY_ALLOW_NO_ISOLATION off while the form
// showed it on, and made a toggled SANDY_OFFLINE stop every launch. The schema
// default tells which spelling a key uses; keys with no default are listed.
export interface BoolEncoding { on: string; off: string }
const BOOL_WORDS:  BoolEncoding = { on: "true", off: "false" };
const BOOL_DIGITS: BoolEncoding = { on: "1",    off: "0" };
const BOOL_NO_DEFAULT: Record<string, BoolEncoding> = {
  CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: BOOL_DIGITS,   // sandy tests `= "1"`
  GOOGLE_GENAI_USE_VERTEXAI: BOOL_WORDS,               // forwarded to the Gemini CLI as-is
};

export function boolEncoding(f: RuleField): BoolEncoding {
  const d = f.default;
  if (d === true || d === false || d === "true" || d === "false") return BOOL_WORDS;
  if (d === "0" || d === "1" || d === 0 || d === 1) return BOOL_DIGITS;
  return BOOL_NO_DEFAULT[f.key] ?? BOOL_DIGITS;   // most of sandy's bools are 0/1
}

/**
 * The checkbox state for a stored/default value: checked only when it is this
 * key's own "on" spelling, because that is the only value sandy treats as on.
 * A file holding the other spelling (`true` for a 0/1 key) shows unchecked.
 */
export function boolChecked(f: RuleField, v: unknown): boolean {
  if (v === true) return true;
  if (v === 1) return boolEncoding(f) === BOOL_DIGITS;
  return v === boolEncoding(f).on;
}

/** A stored bool value sandy won't read as either on or off for this key. */
export function boolUnrecognized(f: RuleField, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const enc = boolEncoding(f);
  return raw !== enc.on && raw !== enc.off;
}

/**
 * The value a control is rendered from. Enums ignore the schema default: an
 * unset enum shows a "(sandy default)" option (value ""), because sandy's real
 * default is often conditional and the first listed option is just a guess.
 * Everything else pre-fills the schema default, as before.
 */
export function displayValue(f: RuleField, raw: string | undefined): unknown {
  if (f.type === "enum") return raw ?? "";
  return raw ?? f.default;
}

/** How the save path serializes a control showing `shown`. Mirrors collect(). */
export function serialize(f: RuleField, shown: unknown): string {
  switch (f.type) {
    case "bool":
      return boolChecked(f, shown) ? boolEncoding(f).on : boolEncoding(f).off;
    case "agent_combo": {
      const selected = new Set(String(shown ?? "").split(",").filter(Boolean));
      return (f.options ?? []).filter((o) => selected.has(o)).join(",");
    }
    case "secret":
      return ""; // secrets are sent only when typed; see collect()
    default:
      return shown == null ? "" : String(shown);
  }
}

/** What an untouched control would serialize to, given only the FILE's value. */
export function baselineValue(f: RuleField, fileValue: string | undefined): string {
  return serialize(f, displayValue(f, fileValue));
}

/** The enum option labels/values to render, preserving an unrecognized stored value. */
export function enumOptions(f: RuleField, shown: string): Array<{ value: string; label: string }> {
  const opts = [{
    value: "",
    label: f.default != null && f.default !== "" ? `(sandy default: ${String(f.default)})` : "(sandy default)",
  }];
  for (const o of f.options ?? []) opts.push({ value: o, label: o });
  // A stored value sandy no longer lists must still be the selected option —
  // otherwise the browser selects "" and the next save CLEARS the user's value.
  if (shown !== "" && !(f.options ?? []).includes(shown)) {
    opts.push({ value: shown, label: `${shown} (not a listed value)` });
  }
  return opts;
}

// ---- Form state transitions -------------------------------------------------
// The webview's state changes, as pure functions so the sequences that broke in
// 0.8.3 review can be tested without a DOM.

/** One rendered control: its current value and what it showed untouched. */
export interface FormRow {
  key: string;
  value: string;
  /** undefined for a secret: sent only when typed, never compared. */
  baseline: string | undefined;
}

/**
 * The rows Save sends, and the rows kept as unsaved edits: those that differ
 * from what the file shows. `pinned` keys are kept even when equal to the
 * baseline: while a save is in flight the baseline is about to change, so an
 * edit back to the old file value is still an edit.
 */
export function pickChanged(rows: FormRow[], pinned: ReadonlySet<string> = new Set()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.baseline === undefined || r.value !== r.baseline || pinned.has(r.key)) out[r.key] = r.value;
  }
  return out;
}

/** The part of a scope's webview state that a save changes. */
export interface FormScope {
  /** The files, as sandy reads them (non-secret keys only). */
  values: Record<string, string>;
  /** Unsaved edits only. */
  form: Record<string, string>;
  secretsPresent: Record<string, boolean>;
  /** Secrets marked "clear on save". Names only. */
  clearPending: string[];
  /** Non-secret keys found in .secrets. */
  misplaced: string[];
}

export interface SentSave { values: Record<string, string>; clearSecrets: string[] }
export interface SavedAck { values?: Record<string, string>; secretsPresent?: Record<string, boolean>; misplaced?: string[] }

/**
 * State after the host confirms a save. The host's read-back becomes the new
 * file baseline; without it, an edit that was later reverted compared as
 * unchanged and was never sent. Edits made while the save was in flight are
 * kept: anything in `form` that differs from what was sent, and clear marks
 * that weren't part of it.
 */
export function applySavedAck(prev: FormScope, sent: SentSave, ack: SavedAck, isSecret: (k: string) => boolean): FormScope {
  let values = ack.values;
  if (!values) {
    // A host that doesn't send its read-back: assume what was sent landed.
    values = { ...prev.values };
    for (const [k, v] of Object.entries(sent.values)) {
      if (isSecret(k)) continue;
      if (v === "") delete values[k]; else values[k] = v;
    }
  }
  let secretsPresent = ack.secretsPresent;
  if (!secretsPresent) {
    secretsPresent = { ...prev.secretsPresent };
    for (const [k, v] of Object.entries(sent.values)) if (isSecret(k) && v) secretsPresent[k] = true;
    for (const k of sent.clearSecrets) delete secretsPresent[k];
  }
  const form: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev.form)) {
    if (!(k in sent.values) || sent.values[k] !== v) form[k] = v;
  }
  const sentClears = new Set(sent.clearSecrets);
  return {
    values,
    form,
    secretsPresent,
    clearPending: prev.clearPending.filter(k => !sentClears.has(k) && secretsPresent![k]),
    misplaced: ack.misplaced ?? prev.misplaced.filter(k => !(k in sent.values)),
  };
}

/**
 * State after the host sends a scope's files (panel open, or shown again after
 * being hidden). The files replace `values`; unsaved edits in `form` and clear
 * marks are kept, so a draft survives both an edit made to the file in an
 * editor and a hide/show, and the untouched fields show the new file.
 */
export function ingestHostScope(
  prev: FormScope,
  host: { values?: Record<string, string>; secretsPresent?: Record<string, boolean>; misplaced?: string[] },
): FormScope {
  const secretsPresent = host.secretsPresent ?? {};
  return {
    values: host.values ?? {},
    form: prev.form ?? {},
    secretsPresent,
    clearPending: (prev.clearPending ?? []).filter(k => secretsPresent[k]),
    misplaced: host.misplaced ?? [],
  };
}
