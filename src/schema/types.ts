// TypeScript shapes for `sandy --print-schema` output, per
// SPEC_INTROSPECTION.md in the sandy repo. Every field is declared optional
// where the spec allows additive change so new sandy versions don't break us.

export interface SandyMeta {
  version: string;
  commit?: string;
  sandbox_min_compat?: string;
}

export type FieldType = "string" | "int" | "bool" | "enum" | "secret" | "agent_combo";

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

export interface SandySchema {
  schema_version: number;
  sandy: SandyMeta;
  config: SandyConfigSection;
  cli_flags?: unknown[];      // not consumed by the extension yet
  agents?: SandyAgent[];
  protected_paths?: unknown;  // ditto
  skill_packs?: unknown[];    // ditto
  compatibility?: SandyCompatibility;
}
