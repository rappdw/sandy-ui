import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { FieldType } from "../schema/types";

export interface FieldDef {
  key: string;
  type: FieldType;   // single source: src/schema/types.ts FIELD_TYPES
  tier: "home" | "workspace" | "secrets";
  privileged?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: unknown;
  description?: string;
  stability?: string;   // passed through so the webview can hide deprecated keys
}

export interface Schema {
  schema_version: number;
  sandy_version:  string;
  fields:         FieldDef[];
  // Additive; the settings webview ignores it. Populated by
  // schema/parse.ts from cli_flags presence — see src/daemon/contract.ts.
  capabilities?: { daemonMode: boolean; approvalsReport?: boolean; updateSessions?: boolean };
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

// sandy's own reading of a config or .secrets file (`_load_sandy_config`):
// only lines matching `^[A-Z_]+=.+` count, the value is everything after the
// first `=`, one trailing CR is dropped, then one leading and one trailing `"`
// and then `'`. A later line for the same key wins, and so does a later file:
// sandy loads ~/.sandy/config, ~/.sandy/.secrets, <ws>/.sandy/config,
// <ws>/.sandy/.secrets in that order. Comments, `export FOO=1`, `KEY=` and
// indented lines are ignored. The settings form uses this, not readKv, so it
// shows what sandy will actually use: `"true"` is on, `true # note` is not.
// readKv stays lenient and verbatim for the approval modal.
const SANDY_KV_LINE = /^([A-Z_]+)=([\s\S]+)$/;   // [\s\S]: `.` would stop at a CR

/** Every assignment sandy reads, in file order (duplicates kept). */
export function parseSandyKvLines(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split("\n")) {
    const m = line.match(SANDY_KV_LINE);
    if (!m) continue;
    let v = m[2];
    // bash `IFS='=' read -r key value` drops ONE trailing '=' when the rest of
    // the value has none (`K=x=` reads x, `K=a=b=` reads a=b=). Before the CR
    // strip, as in sandy: `K=x=\r` keeps its '='.
    if (v.endsWith("=") && !v.slice(0, -1).includes("=")) v = v.slice(0, -1);
    v = v.replace(/\r$/, "");
    v = v.replace(/^"/, "").replace(/"$/, "");
    v = v.replace(/^'/, "").replace(/'$/, "");
    out.push([m[1], v]);
  }
  return out;
}

export function parseSandyKv(text: string): Record<string, string> {
  return Object.fromEntries(parseSandyKvLines(text));
}

/**
 * How a value is written so sandy reads it back exactly. sandy strips one
 * leading/trailing `"` and then `'`, and bash may drop a trailing `=`; single
 * quotes around such a value absorb all of that (`--x="a b"` → `'--x="a b"'`).
 */
export function formatKvValue(v: string): string {
  return /^["']|["'=]$/.test(v) ? `'${v}'` : v;
}

export function readSandyKv(file: string): Record<string, string> {
  return fs.existsSync(file) ? parseSandyKv(fs.readFileSync(file, "utf8")) : {};
}

/**
 * Apply `changes` to a config file's text, keeping everything else as it was:
 * comments, blank lines, unrecognized lines, key order. A string sets the key
 * (the first line sandy reads for it is replaced, later duplicates dropped, so
 * the new value is the one that wins); null deletes every line sandy reads for
 * it. New keys are appended. The old writer rewrote the whole file sorted,
 * which dropped comments and anything it didn't parse.
 */
export function updateKvText(text: string, changes: Record<string, string | null>): string {
  const lines = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  // Keep a CRLF file CRLF: a replaced line keeps its own CR, a new line gets
  // one if the file uses them.
  const fileCr = text.includes("\r\n") ? "\r" : "";
  const placed = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(SANDY_KV_LINE);
    if (!m || !(m[1] in changes)) { out.push(line); continue; }
    const v = changes[m[1]];
    if (v === null || placed.has(m[1])) continue;
    out.push(`${m[1]}=${formatKvValue(v)}${line.endsWith("\r") ? "\r" : ""}`);
    placed.add(m[1]);
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v !== null && !placed.has(k)) out.push(`${k}=${formatKvValue(v)}${fileCr}`);
  }
  return out.length === 0 ? "" : out.join("\n") + "\n";
}

// Atomic write (temp + rename) that keeps an existing file's permission bits,
// capped at `maxMode` (.secrets is tightened to 0600 even if it was created
// world-readable), and writes THROUGH a symlink: renaming onto the link itself
// would replace it with a plain file and leave the dotfiles copy unchanged.
export function writeTextAtomic(file: string, text: string, mode: number, maxMode: number = 0o777) {
  try { file = fs.realpathSync(file); } catch { /* doesn't exist yet */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let keep = mode;
  try { keep = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  keep &= maxMode;
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, text, { mode: keep });
  fs.chmodSync(tmp, keep);   // writeFileSync's mode is filtered by the umask
  fs.renameSync(tmp, file);
}

// Atomic write: temp file + rename. Rewrites the whole file, sorted; the
// settings save path uses updateKvText + writeTextAtomic instead.
export function writeKvAtomic(file: string, kv: Record<string, string>, mode: number = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${v}`).sort().join("\n") + "\n";
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, lines, { mode });
  fs.renameSync(tmp, file);
}

// The ONE rule for which file a key belongs in: its schema type. Earlier builds
// also sent any key sandy can READ from ~/.sandy/.secrets (16 non-secret
// privileged keys on sandy 2.7.1, SANDY_ALLOW_NO_ISOLATION among them) to
// .secrets, where the form could neither show nor clear them — sandy-ui#53.
export function isSecretField(f: FieldDef | undefined): boolean {
  return f?.type === "secret";
}

// Splits a flat KV into config writes and secrets writes, by type.
export function partitionByTier(schema: Schema, kv: Record<string, string>): { config: Record<string, string>; secrets: Record<string, string> } {
  const config: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  const byKey = new Map(schema.fields.map(f => [f.key, f]));
  for (const [k, v] of Object.entries(kv)) {
    if (isSecretField(byKey.get(k))) secrets[k] = v;
    else                             config[k]  = v;
  }
  return { config, secrets };
}

/** What one scope's two files mean to the settings form. */
export interface ScopeView {
  /** Non-secret schema keys, as sandy reads them (`.secrets` beats config). */
  values: Record<string, string>;
  /** Secret-type keys set in either file. Values never leave the host. */
  secretsPresent: Record<string, boolean>;
  /** Non-secret keys found in `.secrets` (written there by sandy-ui < 0.9.0). */
  misplaced: string[];
}

// SANDY_EXTRA_ENV composes instead of last-wins (sandy #388): sandy forwards the
// union of every line's name list across a scope's files. Shown and saved as
// that union, or a save that replaced only the winning line would silently
// drop names forwarded from the other file.
const COMPOSING_KEYS = new Set(["SANDY_EXTRA_ENV"]);

function composedValue(k: string, configText: string, secretsText: string): string | undefined {
  const lists = [...parseSandyKvLines(configText), ...parseSandyKvLines(secretsText)]
    .filter(([key]) => key === k).map(([, v]) => v);
  if (lists.length === 0) return undefined;
  const names = lists.flatMap(v => v.split(",")).map(n => n.trim()).filter(Boolean);
  return [...new Set(names)].join(",");
}

/** Number of lines sandy reads for `k` across both files. */
function lineCount(k: string, ...texts: string[]): number {
  return texts.reduce((n, t) => n + parseSandyKvLines(t).filter(([key]) => key === k).length, 0);
}

export function scopeView(schema: Schema, configText: string, secretsText: string): ScopeView {
  const config  = parseSandyKv(configText);
  const secrets = parseSandyKv(secretsText);
  const view: ScopeView = { values: {}, secretsPresent: {}, misplaced: [] };
  for (const f of schema.fields) {
    const k = f.key;
    if (isSecretField(f)) {
      // A secret in config is reported as present, never sent: the form's
      // values are persisted in plaintext webview state.
      if (k in config || k in secrets) view.secretsPresent[k] = true;
      continue;
    }
    // Within a scope sandy loads .secrets after config, so its copy wins.
    const v = COMPOSING_KEYS.has(k) ? composedValue(k, configText, secretsText)
      : k in secrets ? secrets[k] : config[k];
    if (v !== undefined) view.values[k] = v;
    if (k in secrets) view.misplaced.push(k);
  }
  return view;
}

const readText = (file: string) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

export function readScopeView(scope: Scope, workspaceFsPath: string | undefined, schema: Schema): ScopeView {
  return scopeView(schema,
    readText(configPathFor(scope, workspaceFsPath)),
    readText(secretsPathFor(scope, workspaceFsPath)));
}

export interface SaveResult {
  /** clearSecrets entries that aren't secret-type schema keys. */
  refusedClears: string[];
  /** Keys not in the schema, or values containing a line break. */
  refusedKeys: string[];
  wroteConfig: boolean;
  wroteSecrets: boolean;
}

// Save config + secrets to the chosen scope. Both files live under the same
// `.sandy/` directory at that scope. Workspace-scoped secrets in a git repo
// are a footgun (commit risk) — the UI surfaces a warning about that, but
// doesn't refuse the write.
//
// `kv` holds only keys the user changed. For a non-secret key, "" means "clear
// it" (merging would resurrect the old value). For a secret, "" means "keep
// current" — a password input can't be typed blank to signal deletion, so
// clearSecrets (sandy-ui#25) is the explicit delete, honored only for
// secret-type schema keys: a buggy or hostile message must not be able to
// delete arbitrary config keys through it.
//
// Each key ends up in exactly one file. Writing or clearing a non-secret key
// also removes its .secrets copy: older builds put such keys there, and since
// sandy reads .secrets after config, that stale copy would silently override
// what the form just wrote. Likewise a secret written to .secrets drops any
// copy in config, and clearing a secret clears both.
//
// A file is written only if its text changes, and the write keeps comments,
// order and permissions (updateKvText).
export function saveScope(
  scope: Scope,
  workspaceFsPath: string | undefined,
  schema: Schema,
  kv: Record<string, string>,
  clearSecrets: string[] = []
): SaveResult {
  const configTarget  = configPathFor(scope, workspaceFsPath);
  const secretsTarget = secretsPathFor(scope, workspaceFsPath);
  const configText  = readText(configTarget);
  const secretsText = readText(secretsTarget);
  const config  = parseSandyKv(configText);
  const secrets = parseSandyKv(secretsText);
  const byKey = new Map(schema.fields.map(f => [f.key, f]));

  const configChanges:  Record<string, string | null> = {};
  const secretsChanges: Record<string, string | null> = {};
  const set = (changes: Record<string, string | null>, file: Record<string, string>, k: string, v: string) => {
    // A composing key spread over several lines is collapsed into the one
    // line written, even if the winning line already says `v`.
    if (file[k] !== v || (COMPOSING_KEYS.has(k) && lineCount(k, configText, secretsText) > 1)) changes[k] = v;
  };
  const remove = (changes: Record<string, string | null>, file: Record<string, string>, k: string) => {
    if (k in file) changes[k] = null;
  };

  const refusedKeys: string[] = [];
  for (const [k, v] of Object.entries(kv)) {
    const f = byKey.get(k);
    if (!f || typeof v !== "string" || /[\r\n]/.test(v)) { refusedKeys.push(k); continue; }
    if (isSecretField(f)) {
      if (v === "") continue;   // blank secret = keep current
      set(secretsChanges, secrets, k, v);
      remove(configChanges, config, k);
    } else {
      if (v === "") remove(configChanges, config, k);
      else set(configChanges, config, k, v);
      remove(secretsChanges, secrets, k);
    }
  }

  const refusedClears: string[] = [];
  for (const k of clearSecrets) {
    if (!isSecretField(byKey.get(k))) { refusedClears.push(k); continue; }
    remove(secretsChanges, secrets, k);
    remove(configChanges,  config,  k);
  }

  const newConfig  = updateKvText(configText,  configChanges);
  const newSecrets = updateKvText(secretsText, secretsChanges);
  const wroteConfig  = newConfig  !== configText;
  const wroteSecrets = newSecrets !== secretsText;
  if (wroteConfig)  writeTextAtomic(configTarget,  newConfig,  0o644);
  if (wroteSecrets) writeTextAtomic(secretsTarget, newSecrets, 0o600, 0o600);
  return { refusedClears, refusedKeys, wroteConfig, wroteSecrets };
}
