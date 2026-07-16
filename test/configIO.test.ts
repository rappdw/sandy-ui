import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  readKv, writeKvAtomic, partitionByTier, saveScope,
  configPathFor, secretsPathFor,
  workspaceConfigPath, workspaceSecretsPath,
  HOME_CONFIG, HOME_SECRETS,
  Schema,
} from "../src/settings/configIO";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-test-"));
});
afterEach(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

const schema: Schema = {
  schema_version: 1,
  sandy_version: "test",
  fields: [
    { key: "SANDY_AGENT",            type: "string", tier: "home" },
    { key: "SANDY_TIMEOUT_SECS",     type: "int",    tier: "home" },
    { key: "ANTHROPIC_API_KEY",      type: "secret", tier: "secrets" },
    { key: "OPENAI_API_KEY",         type: "secret", tier: "secrets" },
    { key: "SANDY_SKIP_PERMISSIONS", type: "bool",   tier: "workspace", privileged: true },
    // Edge case: a field whose tier is "secrets" but type is something else
    // (hypothetical future schema). partitionByTier should still route it as secret.
    { key: "WEIRD_TIER_ONLY",        type: "string", tier: "secrets" },
  ],
};

describe("readKv", () => {
  it("returns empty object for non-existent file", () => {
    expect(readKv(path.join(tmp, "does-not-exist"))).toEqual({});
  });

  it("parses a well-formed KV file", () => {
    const f = path.join(tmp, "config");
    fs.writeFileSync(f, "SANDY_AGENT=claude\nSANDY_TIMEOUT_SECS=3600\n");
    expect(readKv(f)).toEqual({
      SANDY_AGENT: "claude",
      SANDY_TIMEOUT_SECS: "3600",
    });
  });

  it("tolerates leading/trailing whitespace around key and =", () => {
    const f = path.join(tmp, "config");
    fs.writeFileSync(f, "  SANDY_AGENT  =  claude\n");
    expect(readKv(f)).toEqual({ SANDY_AGENT: "claude" });
  });

  it("skips lines that aren't KEY=VALUE (comments, blanks, junk)", () => {
    const f = path.join(tmp, "config");
    fs.writeFileSync(f, "# comment\n\nSANDY_AGENT=claude\nrandom garbage\nlowercase=ignored\n");
    expect(readKv(f)).toEqual({ SANDY_AGENT: "claude" });
  });

  it("preserves '=' inside values (matches up to first '=' only)", () => {
    const f = path.join(tmp, "config");
    fs.writeFileSync(f, `SANDY_CUSTOM=a=b=c\n`);
    expect(readKv(f)).toEqual({ SANDY_CUSTOM: "a=b=c" });
  });

  it("strips whitespace immediately around '=' but preserves trailing whitespace", () => {
    // Contract: `\s*=\s*` in the regex eats whitespace surrounding '=', so
    // leading-whitespace values are lost. Trailing whitespace IS preserved
    // (regex captures greedy `(.*)$`). This matches dotenv-style parsers and
    // bash's `source` behavior on unquoted values; users wanting verbatim
    // leading whitespace should... not, basically.
    const f = path.join(tmp, "config");
    fs.writeFileSync(f, `SANDY_X=  spaces   \n`);
    expect(readKv(f).SANDY_X).toBe("spaces   ");
  });

  it("requires uppercase letter start (matches sandy's KEY convention)", () => {
    const f = path.join(tmp, "config");
    fs.writeFileSync(f, "_NOT_VALID=x\n9STARTS_WITH_DIGIT=y\nVALID=z\n");
    expect(readKv(f)).toEqual({ VALID: "z" });
  });
});

describe("writeKvAtomic", () => {
  it("creates parent directory if missing", () => {
    const f = path.join(tmp, "nested", "dir", "config");
    writeKvAtomic(f, { A: "1" });
    expect(fs.existsSync(f)).toBe(true);
  });

  it("writes keys in sorted order", () => {
    const f = path.join(tmp, "config");
    writeKvAtomic(f, { ZEBRA: "z", APPLE: "a", MIDDLE: "m" });
    expect(fs.readFileSync(f, "utf8")).toBe("APPLE=a\nMIDDLE=m\nZEBRA=z\n");
  });

  it("round-trips through readKv (no leading whitespace in values)", () => {
    // Leading whitespace in values doesn't round-trip — readKv strips it (see
    // its dedicated test). So the round-trip contract is "values without
    // leading whitespace are preserved exactly."
    const f = path.join(tmp, "config");
    const original = { SANDY_AGENT: "claude", SANDY_TIMEOUT_SECS: "3600", SANDY_X: "trailing-ok   " };
    writeKvAtomic(f, original);
    expect(readKv(f)).toEqual(original);
  });

  it("respects the mode parameter (default 0o600)", () => {
    if (process.platform === "win32") return;  // mode bits don't apply
    const f = path.join(tmp, "config");
    writeKvAtomic(f, { A: "1" });
    const stat = fs.statSync(f);
    // Compare only the permission bits (lower 9 bits)
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("respects an explicit mode override (0o644)", () => {
    if (process.platform === "win32") return;
    const f = path.join(tmp, "config");
    writeKvAtomic(f, { A: "1" }, 0o644);
    expect(fs.statSync(f).mode & 0o777).toBe(0o644);
  });

  it("never leaves the temp file behind on success", () => {
    const f = path.join(tmp, "config");
    writeKvAtomic(f, { A: "1" });
    const leftovers = fs.readdirSync(tmp).filter(n => n.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });
});

describe("partitionByTier", () => {
  it("routes secret-typed fields to secrets bucket", () => {
    const { config, secrets } = partitionByTier(schema, {
      SANDY_AGENT: "claude",
      ANTHROPIC_API_KEY: "sk-test-123",
    });
    expect(config).toEqual({ SANDY_AGENT: "claude" });
    expect(secrets).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
  });

  it("routes secrets-tier fields (regardless of type) to secrets", () => {
    const { config, secrets } = partitionByTier(schema, {
      WEIRD_TIER_ONLY: "value",
    });
    expect(config).toEqual({});
    expect(secrets).toEqual({ WEIRD_TIER_ONLY: "value" });
  });

  it("treats unknown keys as config (graceful degradation)", () => {
    const { config, secrets } = partitionByTier(schema, {
      SANDY_NEW_KEY_NOT_IN_SCHEMA: "value",
    });
    expect(config).toEqual({ SANDY_NEW_KEY_NOT_IN_SCHEMA: "value" });
    expect(secrets).toEqual({});
  });

  it("handles empty input cleanly", () => {
    expect(partitionByTier(schema, {})).toEqual({ config: {}, secrets: {} });
  });

  it("preserves all of a multi-key partition", () => {
    const { config, secrets } = partitionByTier(schema, {
      SANDY_AGENT: "claude",
      SANDY_TIMEOUT_SECS: "3600",
      ANTHROPIC_API_KEY: "k1",
      OPENAI_API_KEY: "k2",
    });
    expect(config).toEqual({ SANDY_AGENT: "claude", SANDY_TIMEOUT_SECS: "3600" });
    expect(secrets).toEqual({ ANTHROPIC_API_KEY: "k1", OPENAI_API_KEY: "k2" });
  });
});

describe("configPathFor / secretsPathFor", () => {
  it("home scope returns HOME_CONFIG / HOME_SECRETS regardless of workspace", () => {
    expect(configPathFor("home")).toBe(HOME_CONFIG);
    expect(configPathFor("home", "/some/workspace")).toBe(HOME_CONFIG);
    expect(secretsPathFor("home")).toBe(HOME_SECRETS);
  });

  it("workspace scope returns scope-specific paths under .sandy/", () => {
    expect(configPathFor("workspace", "/foo")).toBe(workspaceConfigPath("/foo"));
    expect(secretsPathFor("workspace", "/foo")).toBe(workspaceSecretsPath("/foo"));
    expect(workspaceConfigPath("/foo")).toBe(path.join("/foo", ".sandy", "config"));
    expect(workspaceSecretsPath("/foo")).toBe(path.join("/foo", ".sandy", ".secrets"));
  });

  it("throws when workspace scope is requested without a path", () => {
    expect(() => configPathFor("workspace")).toThrow(/workspace scope requires/);
    expect(() => secretsPathFor("workspace")).toThrow(/workspace scope requires/);
  });
});

describe("saveScope (workspace tmp-dir, never touches HOME)", () => {
  it("writes config keys to <ws>/.sandy/config and secrets to <ws>/.sandy/.secrets", () => {
    saveScope("workspace", tmp, schema, {
      SANDY_AGENT: "claude",
      ANTHROPIC_API_KEY: "sk-test-123",
    });
    expect(readKv(workspaceConfigPath(tmp))).toEqual({ SANDY_AGENT: "claude" });
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ ANTHROPIC_API_KEY: "sk-test-123" });
  });

  it("merges with existing on disk (doesn't drop keys the user didn't change)", () => {
    // Pre-populate
    writeKvAtomic(workspaceConfigPath(tmp), { SANDY_PRE_EXISTING: "kept" });
    writeKvAtomic(workspaceSecretsPath(tmp), { LEGACY_SECRET: "still-here" });
    // Save adds new, doesn't remove old
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "claude" });
    expect(readKv(workspaceConfigPath(tmp))).toEqual({
      SANDY_PRE_EXISTING: "kept",
      SANDY_AGENT: "claude",
    });
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ LEGACY_SECRET: "still-here" });
  });

  it("doesn't create an empty .secrets file when no secrets are involved", () => {
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "claude" });
    expect(fs.existsSync(workspaceSecretsPath(tmp))).toBe(false);
  });

  it("creates .secrets when a secret is included even if config is unchanged", () => {
    saveScope("workspace", tmp, schema, { ANTHROPIC_API_KEY: "sk-test" });
    expect(fs.existsSync(workspaceSecretsPath(tmp))).toBe(true);
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
  });

  it("config file gets 0o644 mode, secrets file gets 0o600", () => {
    if (process.platform === "win32") return;
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "claude", ANTHROPIC_API_KEY: "sk" });
    expect(fs.statSync(workspaceConfigPath(tmp)).mode  & 0o777).toBe(0o644);
    expect(fs.statSync(workspaceSecretsPath(tmp)).mode & 0o777).toBe(0o600);
  });

  it("empty-string value CLEARS the key instead of resurrecting the old value (B2)", () => {
    writeKvAtomic(workspaceConfigPath(tmp), { SANDY_AGENT: "claude", SANDY_PRE_EXISTING: "kept" });
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "" });
    expect(readKv(workspaceConfigPath(tmp))).toEqual({ SANDY_PRE_EXISTING: "kept" });
  });

  it("empty-string value for a key not on disk is a no-op", () => {
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "" });
    expect(readKv(workspaceConfigPath(tmp))).toEqual({});
  });

  it("empty-string never deletes or writes SECRETS (blank secret means keep)", () => {
    writeKvAtomic(workspaceSecretsPath(tmp), { ANTHROPIC_API_KEY: "sk-keep" });
    saveScope("workspace", tmp, schema, { ANTHROPIC_API_KEY: "" });
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ ANTHROPIC_API_KEY: "sk-keep" });
  });

  it("clearSecrets removes an existing secret and keeps others; file rewritten without the key", () => {
    writeKvAtomic(workspaceSecretsPath(tmp), { ANTHROPIC_API_KEY: "sk-gone", OPENAI_API_KEY: "sk-kept" });
    const { refusedClears } = saveScope("workspace", tmp, schema, {}, ["ANTHROPIC_API_KEY"]);
    expect(refusedClears).toEqual([]);
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ OPENAI_API_KEY: "sk-kept" });
  });

  it("clearSecrets on a non-secret key (per schema) is REFUSED (config key untouched)", () => {
    writeKvAtomic(workspaceConfigPath(tmp), { SANDY_AGENT: "claude" });
    const { refusedClears } = saveScope("workspace", tmp, schema, {}, ["SANDY_AGENT"]);
    expect(refusedClears).toEqual(["SANDY_AGENT"]);
    expect(readKv(workspaceConfigPath(tmp))).toEqual({ SANDY_AGENT: "claude" });
  });

  it("clearSecrets simultaneously with a new value for a DIFFERENT secret works", () => {
    writeKvAtomic(workspaceSecretsPath(tmp), { ANTHROPIC_API_KEY: "sk-gone" });
    const { refusedClears } = saveScope(
      "workspace", tmp, schema,
      { OPENAI_API_KEY: "sk-new" },
      ["ANTHROPIC_API_KEY"],
    );
    expect(refusedClears).toEqual([]);
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ OPENAI_API_KEY: "sk-new" });
  });

  it("clearing the last secret leaves an empty-but-valid secrets file (readKv → {})", () => {
    writeKvAtomic(workspaceSecretsPath(tmp), { ANTHROPIC_API_KEY: "sk-only" });
    saveScope("workspace", tmp, schema, {}, ["ANTHROPIC_API_KEY"]);
    expect(fs.existsSync(workspaceSecretsPath(tmp))).toBe(true);
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({});
  });
});
