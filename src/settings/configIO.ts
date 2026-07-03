import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface FieldDef {
  key: string;
  type: "string" | "int" | "bool" | "enum" | "agent_combo" | "secret";
  tier: "home" | "workspace" | "secrets";
  privileged?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: unknown;
  description?: string;
}

export interface Schema {
  schema_version: number;
  sandy_version:  string;
  fields:         FieldDef[];
}

export type Scope = "home" | "workspace";

export const HOME_CONFIG     = path.join(os.homedir(), ".sandy", "config");
export const HOME_SECRETS    = path.join(os.homedir(), ".sandy", ".secrets");

export function workspaceConfigPath (workspaceFsPath: string): string { return path.join(workspaceFsPath, ".sandy", "config");   }
export function workspaceSecretsPath(workspaceFsPath: string): string { return path.join(workspaceFsPath, ".sandy", ".secrets"); }

export function configPathFor(scope: Scope, workspaceFsPath?: string): string {
  if (scope === "home") return HOME_CONFIG;
  if (!workspaceFsPath) throw new Error("workspace scope requires an open workspace folder");
  return workspaceConfigPath(workspaceFsPath);
}
export function secretsPathFor(scope: Scope, workspaceFsPath?: string): string {
  if (scope === "home") return HOME_SECRETS;
  if (!workspaceFsPath) throw new Error("workspace scope requires an open workspace folder");
  return workspaceSecretsPath(workspaceFsPath);
}

export function readKv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// Atomic write: temp file + rename. Mirrors the SPEC's "Save writes the file
// atomically (temp + rename)" requirement and matches what sandy's CLI does
// for the same files.
export function writeKvAtomic(file: string, kv: Record<string, string>, mode: number = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v}`).sort().join("\n") + "\n";
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, lines, { mode });
  fs.renameSync(tmp, file);
}

// Splits a flat KV into config-tier and secrets-tier writes, per SPEC §"Settings editor"
// which routes secret-typed fields to ~/.sandy/.secrets (not ~/.sandy/config).
export function partitionByTier(schema: Schema, kv: Record<string, string>): { config: Record<string, string>; secrets: Record<string, string> } {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const byKey = new Map(schema.fields.map(f => [f.key, f]));
  for (const [k, v] of Object.entries(kv)) {
    const f = byKey.get(k);
    if (f?.tier === "secrets" || f?.type === "secret") secrets[k] = v;
    else                                                config[k]  = v;
  }
  return { config, secrets };
}

// Save config + secrets to the chosen scope. Both files live under the same
// `.sandy/` directory at that scope. Workspace-scoped secrets in a git repo
// are a footgun (commit risk) — the UI surfaces a warning about that, but
// doesn't refuse the write.
//
// Empty-string values mean "clear this key": the settings webview sends ""
// for fields the user emptied (and for agent_combo with nothing checked).
// Merging existing-over-incoming would silently resurrect the old value on
// save — the user cleared a field, hit Save, and the value came back.
// Secrets are exempt from this convention: the UI's blank-secret input means
// "keep current value" and collect() never sends blank secrets.
export function saveScope(
  scope: Scope,
  workspaceFsPath: string | undefined,
  schema: Schema,
  kv: Record<string, string>
) {
  const { config, secrets } = partitionByTier(schema, kv);
  const configTarget  = configPathFor(scope, workspaceFsPath);
  const secretsTarget = secretsPathFor(scope, workspaceFsPath);
  const existingConfig  = readKv(configTarget);
  const existingSecrets = readKv(secretsTarget);

  const mergedConfig: Record<string, string> = { ...existingConfig };
  for (const [k, v] of Object.entries(config)) {
    if (v === "") delete mergedConfig[k];
    else mergedConfig[k] = v;
  }
  writeKvAtomic(configTarget, mergedConfig, 0o644);

  const nonEmptySecrets = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== ""));
  if (Object.keys(nonEmptySecrets).length > 0 || Object.keys(existingSecrets).length > 0) {
    writeKvAtomic(secretsTarget, { ...existingSecrets, ...nonEmptySecrets }, 0o600);
  }
}
