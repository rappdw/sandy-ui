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

/** The checkbox state a bool control shows for a stored/default value. */
export function boolChecked(v: unknown): boolean {
  return v === "true" || v === "1" || v === true;
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
      return boolChecked(shown) ? "true" : "false";
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
