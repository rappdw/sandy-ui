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
import type { SandySchema, SandyConfigKey, SandyCliFlag } from "./types";

// sandy-ui feature-detects daemon support on flag presence, per the frozen
// contract on rappdw/sandy-ui#12 — never on version-string parsing.
const flagName = (f: SandyCliFlag | string): string | undefined =>
  typeof f === "string" ? f : f?.name;

export function parseSandySchema(sandy: SandySchema): Schema {
  const fields: FieldDef[] = [];
  const cfg = sandy.config ?? {};

  // An agent_combo key (SANDY_AGENT) carries no `choices`; the agent list is
  // the schema's top-level `agents` array (sandy-ui#52). Without it the form
  // rendered a checkbox group with no boxes.
  const agentNames = (sandy.agents ?? []).map(a => a?.name).filter((n): n is string => typeof n === "string" && n !== "");
  const withAgents = (f: FieldDef): FieldDef =>
    f.type === "agent_combo" && !f.options?.length && agentNames.length ? { ...f, options: agentNames } : f;

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
  for (let i = 0; i < fields.length; i++) fields[i] = withAgents(fields[i]);

  const daemonMode = (sandy.cli_flags ?? []).some(f => flagName(f) === "--start");
  // `sandy --approvals` (2.7.0, #296) — the launch-preview report.
  const approvalsReport = (sandy.cli_flags ?? []).some(f => flagName(f) === "--approvals");

  return {
    schema_version: sandy.schema_version,
    sandy_version:  sandy.sandy?.version ?? "unknown",
    fields,
    capabilities: { daemonMode, approvalsReport },
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
  if (k.stability) f.stability = k.stability;
  if (k.choices)        f.options = k.choices;
  if (k.pattern != null) f.pattern = k.pattern;
  if (k.min != null)     f.min = k.min;
  if (k.max != null)     f.max = k.max;
  if (k.default !== undefined) f.default = k.default;
  return f;
}

function defaultTierFor(k: SandyConfigKey, fallback: FieldDef["tier"]): FieldDef["tier"] {
  // Only secret-TYPE keys belong in .secrets. `sources` lists where sandy can
  // READ a key from, and every privileged key lists home_secrets — routing on
  // that sent SANDY_ALLOW_NO_ISOLATION and 15 other non-secrets to .secrets,
  // where the form couldn't show or clear them (sandy-ui#53).
  if (k.type === "secret") return "secrets";
  // Workspace-preferred sources → "workspace" tier.
  if (k.sources?.length === 1 && k.sources[0] === "workspace_config") return "workspace";
  // Otherwise the caller's fallback (e.g., privileged_keys default to "workspace",
  // passive_keys default to "home").
  return fallback;
}
