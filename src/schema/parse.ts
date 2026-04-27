// Translates sandy's --print-schema JSON into the extension's internal
// Schema shape. Sandy's spec keeps config in three separate arrays
// (privileged / passive / env_only); the extension wants a single flat
// fields[] for the settings webview to iterate.
//
// Field-name renames sandy → internal:
//   name                       → key
//   choices                    → options
//   passive_approval_required  → privileged
//   sources[]                  → tier (best-effort categorization)
//
// env_only_keys are skipped — they're env vars, not file-configurable, so
// the settings form has nothing useful to render for them.

import type { Schema, FieldDef } from "../settings/configIO";
import type { SandySchema, SandyConfigKey } from "./types";

export function parseSandySchema(sandy: SandySchema): Schema {
  const fields: FieldDef[] = [];
  const cfg = sandy.config ?? {};

  for (const k of cfg.privileged_keys ?? []) {
    // privileged_keys always need approval when set from workspace; mark
    // privileged: true so the UI shows the yellow border + warning.
    // tier is a hint — we still show in both Project and Global tabs.
    fields.push(toFieldDef(k, /* privilegedOverride */ true, defaultTierFor(k, "workspace")));
  }
  for (const k of cfg.passive_keys ?? []) {
    fields.push(toFieldDef(k, /* privilegedOverride */ k.passive_approval_required, defaultTierFor(k, "home")));
  }
  // env_only_keys: deliberately skipped — not file-configurable.

  return {
    schema_version: sandy.schema_version,
    sandy_version:  sandy.sandy?.version ?? "unknown",
    fields,
  };
}

function toFieldDef(k: SandyConfigKey, privileged: boolean | undefined, tier: FieldDef["tier"]): FieldDef {
  const f: FieldDef = {
    key: k.name,
    type: k.type,
    tier,
    description: k.description,
  };
  if (privileged) f.privileged = true;
  if (k.choices)        f.options = k.choices;
  if (k.pattern != null) f.pattern = k.pattern;
  if (k.min != null)     f.min = k.min;
  if (k.max != null)     f.max = k.max;
  if (k.default !== undefined) f.default = k.default;
  return f;
}

function defaultTierFor(k: SandyConfigKey, fallback: FieldDef["tier"]): FieldDef["tier"] {
  // Secret type or sources-includes-home_secrets → "secrets" tier.
  if (k.type === "secret") return "secrets";
  if (k.sources?.includes("home_secrets")) return "secrets";
  // Workspace-preferred sources → "workspace" tier.
  if (k.sources?.length === 1 && k.sources[0] === "workspace_config") return "workspace";
  // Otherwise the caller's fallback (e.g., privileged_keys default to "workspace",
  // passive_keys default to "home").
  return fallback;
}
