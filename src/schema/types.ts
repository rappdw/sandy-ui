// TypeScript shapes for `sandy --print-schema` output, per
// SPEC_INTROSPECTION.md in the sandy repo. Every field is declared optional
// where the spec allows additive change so new sandy versions don't break us.

export interface SandyMeta {
  version: string;
  commit?: string;
  sandbox_min_compat?: string;
}

// Runtime list so tests can check it against real `sandy --print-schema`
// output. The settings webview keeps its own copy (FieldDef in
// media/settings/src/settings.ts — host and webview share no files by
// design); test/schema-real-fixture.test.ts fails if the two drift.
export const FIELD_TYPES = ["string", "path", "int", "bool", "enum", "secret", "agent_combo"] as const;
export type FieldType = typeof FIELD_TYPES[number];

export interface SandyConfigKey {
  name: string;
  type: FieldType;
  choices?: string[];
  default?: unknown;
  description?: string;
  pattern?: string;
  min?: number;
  max?: number;
  sources?: Array<"home_config" | "home_secrets" | "workspace_config" | "env">;
  passive_approval_required?: boolean;
  stability?: string;   // "stable" | "experimental" | "deprecated"
  // sandy >= 2.8.0 (#440): how a value of this type is stored — the fallback
  // for rendering a `type` this build doesn't know.
  base_type?: "string" | "bool" | "int";
}

export interface SandyConfigSection {
  privileged_keys?: SandyConfigKey[];
  passive_keys?: SandyConfigKey[];
  env_only_keys?: SandyConfigKey[];
}

export interface SandyAgent {
  name: string;
  image?: string;
  features?: string[];
  credentials?: { probe_order?: string[] };
}

export interface SandyCompatibility {
  current_schema_version?: number;
  supported_schema_versions?: number[];
  deprecated_schema_versions?: number[];
}

// sandy emits cli_flags as objects with a `name` field (e.g. {name: "--start"});
// tolerate bare strings defensively since the spec doesn't pin the exact shape.
export interface SandyCliFlag { name?: string; [k: string]: unknown }

export interface SandySchema {
  schema_version: number;
  sandy: SandyMeta;
  config: SandyConfigSection;
  cli_flags?: Array<SandyCliFlag | string>;  // feature-detect daemon support ("--start" presence)
  agents?: SandyAgent[];
  protected_paths?: unknown;  // ditto
  skill_packs?: unknown[];    // ditto
  compatibility?: SandyCompatibility;
}
