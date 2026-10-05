import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  readKv, writeKvAtomic, partitionByTier, saveScope,
  parseSandyKv, updateKvText, scopeView, readScopeView, formatKvValue,
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
    // A non-secret whose tier says "secrets": what parse.ts produced for every
    // privileged key before sandy-ui#53. Type decides; it belongs in config.
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

  it("routes by TYPE only: a non-secret with tier 'secrets' goes to config (#53)", () => {
    const { config, secrets } = partitionByTier(schema, {
      WEIRD_TIER_ONLY: "value",
    });
    expect(config).toEqual({ WEIRD_TIER_ONLY: "value" });
    expect(secrets).toEqual({});
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

describe("saveScope writes a file only when something in it changes", () => {
  // The settings form now sends only changed keys, so most Saves send nothing.
  // A no-op Save must be a true no-op: writeKvAtomic rewrites the whole file
  // (sorted, comments and unrecognized lines dropped, mode reset), and used to
  // run unconditionally.
  it("does not create a missing config (or its .sandy/ dir) when nothing changed", () => {
    saveScope("workspace", tmp, schema, {});
    expect(fs.existsSync(workspaceConfigPath(tmp))).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".sandy"))).toBe(false);
  });

  it("leaves an existing config byte-identical — comments and all — when nothing changed", () => {
    const cfg = workspaceConfigPath(tmp);
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const original = "# my sandy config\nSANDY_AGENT=claude\n\n# keep this\nexport FOO=1\n";
    fs.writeFileSync(cfg, original);
    saveScope("workspace", tmp, schema, {});
    expect(fs.readFileSync(cfg, "utf8")).toBe(original);
  });

  it("leaves an existing secrets file byte-identical when only config changes", () => {
    const sec = workspaceSecretsPath(tmp);
    fs.mkdirSync(path.dirname(sec), { recursive: true });
    const original = "# secrets\nLEGACY_SECRET=still-here\n";
    fs.writeFileSync(sec, original);
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "codex" });
    expect(fs.readFileSync(sec, "utf8")).toBe(original);
    expect(readKv(workspaceConfigPath(tmp))).toEqual({ SANDY_AGENT: "codex" });
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

// ---- sandy-ui#53 -------------------------------------------------------------

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => fs.readFileSync(file, "utf8");
const kvText = (kv: Record<string, string>) => Object.entries(kv).map(([k, v]) => `${k}=${v}\n`).join("");

describe("parseSandyKv reads a file the way sandy does", () => {
  it("strips one CR and one pair of quotes, as _load_sandy_config does", () => {
    expect(parseSandyKv('A=true\r\nB="true"\nC=\'x\'\nD="4"\n')).toEqual({ A: "true", B: "true", C: "x", D: "4" });
  });
  it("keeps a trailing comment as part of the value (sandy does too)", () => {
    expect(parseSandyKv("A=true # note\n")).toEqual({ A: "true # note" });
  });
  it("ignores comments, export lines, indented lines, empty values and lowercase keys", () => {
    expect(parseSandyKv("# A=1\nexport B=1\n  C=1\nD=\nlower=1\nE=ok\n")).toEqual({ E: "ok" });
  });
  it("later lines win", () => {
    expect(parseSandyKv("A=1\nA=2\n")).toEqual({ A: "2" });
  });
});

describe("updateKvText keeps the rest of the file", () => {
  const original = "# header\nSANDY_AGENT=claude\n\nexport FOO=1\n# trailing\nSANDY_X=1\n";
  it("replaces a value in place", () => {
    expect(updateKvText(original, { SANDY_AGENT: "codex" }))
      .toBe("# header\nSANDY_AGENT=codex\n\nexport FOO=1\n# trailing\nSANDY_X=1\n");
  });
  it("deletes only the key's lines", () => {
    expect(updateKvText(original, { SANDY_X: null })).toBe("# header\nSANDY_AGENT=claude\n\nexport FOO=1\n# trailing\n");
  });
  it("appends new keys", () => {
    expect(updateKvText(original, { NEW: "v" })).toBe(original + "NEW=v\n");
  });
  it("collapses duplicates so the new value is the one sandy reads", () => {
    const out = updateKvText("A=1\nB=x\nA=2\n", { A: "3" });
    expect(out).toBe("A=3\nB=x\n");
    expect(parseSandyKv(out).A).toBe("3");
  });
  it("handles a file without a trailing newline, and an empty file", () => {
    expect(updateKvText("A=1", { B: "2" })).toBe("A=1\nB=2\n");
    expect(updateKvText("", { A: "1" })).toBe("A=1\n");
    expect(updateKvText("A=1\n", { A: null })).toBe("");
  });
  it("is the identity with no changes", () => {
    expect(updateKvText(original, {})).toBe(original);
  });
});

describe("saveScope keeps comments, order and permissions", () => {
  it("edits one line of a commented config", () => {
    const cfg = workspaceConfigPath(tmp);
    write(cfg, "# mine\nSANDY_AGENT=claude\nexport FOO=1\nSANDY_TIMEOUT_SECS=5\n");
    saveScope("workspace", tmp, schema, { SANDY_TIMEOUT_SECS: "9" });
    expect(read(cfg)).toBe("# mine\nSANDY_AGENT=claude\nexport FOO=1\nSANDY_TIMEOUT_SECS=9\n");
  });
  it("keeps an existing file's mode", () => {
    if (process.platform === "win32") return;
    const cfg = workspaceConfigPath(tmp);
    write(cfg, "SANDY_AGENT=claude\n");
    fs.chmodSync(cfg, 0o600);
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "codex" });
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
  });
  it("sending a value equal to the file writes nothing", () => {
    const cfg = workspaceConfigPath(tmp);
    write(cfg, 'SANDY_AGENT="claude"\n');
    const r = saveScope("workspace", tmp, schema, { SANDY_AGENT: "claude" });
    expect(r.wroteConfig).toBe(false);
    expect(read(cfg)).toBe('SANDY_AGENT="claude"\n');
  });
  it("reports what it wrote", () => {
    expect(saveScope("workspace", tmp, schema, {})).toMatchObject({ wroteConfig: false, wroteSecrets: false });
    expect(saveScope("workspace", tmp, schema, { SANDY_AGENT: "x", ANTHROPIC_API_KEY: "k" }))
      .toMatchObject({ wroteConfig: true, wroteSecrets: true });
  });
  it("refuses keys outside the schema and values with line breaks", () => {
    const r = saveScope("workspace", tmp, schema, { NOT_IN_SCHEMA: "x", SANDY_AGENT: "a\nSANDY_SKIP_PERMISSIONS=true" });
    expect(r.refusedKeys.sort()).toEqual(["NOT_IN_SCHEMA", "SANDY_AGENT"]);
    expect(fs.existsSync(workspaceConfigPath(tmp))).toBe(false);
  });
});

describe("saveScope migrates non-secret keys out of .secrets (#53)", () => {
  // sandy loads .secrets AFTER config within a scope, so a stale .secrets copy
  // overrides whatever the form writes to config. Every write or clear of a
  // non-secret key must remove it.
  it("writing a key moves it from .secrets to config", () => {
    write(workspaceSecretsPath(tmp), "# s\nSANDY_SKIP_PERMISSIONS=true\nANTHROPIC_API_KEY=sk\n");
    saveScope("workspace", tmp, schema, { SANDY_SKIP_PERMISSIONS: "false" });
    expect(readKv(workspaceConfigPath(tmp))).toEqual({ SANDY_SKIP_PERMISSIONS: "false" });
    expect(read(workspaceSecretsPath(tmp))).toBe("# s\nANTHROPIC_API_KEY=sk\n");
  });
  it("clearing a key removes it from both files", () => {
    write(workspaceConfigPath(tmp), "SANDY_SKIP_PERMISSIONS=false\n");
    write(workspaceSecretsPath(tmp), "SANDY_SKIP_PERMISSIONS=true\n");
    saveScope("workspace", tmp, schema, { SANDY_SKIP_PERMISSIONS: "" });
    expect(readScopeView("workspace", tmp, schema).values).toEqual({});
  });
  it("writing the value config already has still removes the overriding .secrets copy", () => {
    write(workspaceConfigPath(tmp), "SANDY_SKIP_PERMISSIONS=false\n");
    write(workspaceSecretsPath(tmp), "SANDY_SKIP_PERMISSIONS=true\n");
    const r = saveScope("workspace", tmp, schema, { SANDY_SKIP_PERMISSIONS: "false" });
    expect(r).toMatchObject({ wroteConfig: false, wroteSecrets: true });
    expect(readScopeView("workspace", tmp, schema).values).toEqual({ SANDY_SKIP_PERMISSIONS: "false" });
  });
  it("a secret written to .secrets drops its config copy; clearing a secret clears both", () => {
    write(workspaceConfigPath(tmp), "ANTHROPIC_API_KEY=old\nSANDY_AGENT=claude\n");
    saveScope("workspace", tmp, schema, { ANTHROPIC_API_KEY: "new" });
    expect(readKv(workspaceConfigPath(tmp))).toEqual({ SANDY_AGENT: "claude" });
    expect(readKv(workspaceSecretsPath(tmp))).toEqual({ ANTHROPIC_API_KEY: "new" });
    write(workspaceConfigPath(tmp), "ANTHROPIC_API_KEY=again\n");
    saveScope("workspace", tmp, schema, {}, ["ANTHROPIC_API_KEY"]);
    expect(readScopeView("workspace", tmp, schema).secretsPresent).toEqual({});
  });
  it("leaves keys outside the schema in .secrets alone (e.g. names SANDY_EXTRA_ENV forwards)", () => {
    write(workspaceSecretsPath(tmp), "HA_TOKEN=abc\nSANDY_SKIP_PERMISSIONS=true\n");
    saveScope("workspace", tmp, schema, { SANDY_SKIP_PERMISSIONS: "true" });
    expect(read(workspaceSecretsPath(tmp))).toBe("HA_TOKEN=abc\n");
  });
});

describe("scopeView: what the form is told about a scope", () => {
  it("shows a non-secret from .secrets, which beats config, and flags it misplaced", () => {
    const v = scopeView(schema, kvText({ SANDY_SKIP_PERMISSIONS: "false", SANDY_AGENT: "claude" }), kvText({ SANDY_SKIP_PERMISSIONS: "true" }));
    expect(v.values).toEqual({ SANDY_SKIP_PERMISSIONS: "true", SANDY_AGENT: "claude" });
    expect(v.misplaced).toEqual(["SANDY_SKIP_PERMISSIONS"]);
  });
  it("never sends a secret's value, even one stored in config", () => {
    const v = scopeView(schema, kvText({ ANTHROPIC_API_KEY: "sk-in-config" }), kvText({ OPENAI_API_KEY: "sk" }));
    expect(JSON.stringify(v)).not.toContain("sk-in-config");
    expect(v.values).toEqual({});
    expect(v.secretsPresent).toEqual({ ANTHROPIC_API_KEY: true, OPENAI_API_KEY: true });
  });
  it("sends only schema keys (nothing else from .secrets leaves the host)", () => {
    const v = scopeView(schema, kvText({ UNKNOWN: "1" }), kvText({ HA_TOKEN: "abc" }));
    expect(v).toEqual({ values: {}, secretsPresent: {}, misplaced: [] });
  });
});

describe("review fixes (#53)", () => {
  const extraSchema: Schema = { ...schema, fields: [...schema.fields, { key: "SANDY_EXTRA_ENV", type: "string", tier: "workspace", privileged: true }] };

  it("parses a trailing '=' the way bash read does", () => {
    expect(parseSandyKv("A==\nB=x=\nC=x==\nD=a=b=\nE=x=\r\n")).toEqual({ A: "", B: "x", C: "x==", D: "a=b=", E: "x=" });
  });

  it("writes values sandy would otherwise mangle so they read back exactly", () => {
    for (const v of ['--x="a b"', "'x", 'a"', "abc=", "plain", "a=b", "it's"]) {
      expect(parseSandyKv(updateKvText("", { K: v })).K, v).toBe(v);
    }
    expect(formatKvValue("plain")).toBe("plain");
  });

  it("keeps a CRLF file CRLF", () => {
    expect(updateKvText("A=1\r\nB=2\r\n", { A: "3", N: "4" })).toBe("A=3\r\nB=2\r\nN=4\r\n");
  });

  it("tightens a world-readable .secrets to 0600 when it writes it", () => {
    if (process.platform === "win32") return;
    const sec = workspaceSecretsPath(tmp);
    write(sec, "OPENAI_API_KEY=x\n");
    fs.chmodSync(sec, 0o644);
    saveScope("workspace", tmp, schema, { ANTHROPIC_API_KEY: "k" });
    expect(fs.statSync(sec).mode & 0o777).toBe(0o600);
  });

  it("writes through a symlinked config instead of replacing the link", () => {
    if (process.platform === "win32") return;
    const real = path.join(tmp, "dotfiles", "sandy-config");
    write(real, "SANDY_AGENT=claude\n");
    fs.mkdirSync(path.join(tmp, ".sandy"), { recursive: true });
    fs.symlinkSync(real, workspaceConfigPath(tmp));
    saveScope("workspace", tmp, schema, { SANDY_AGENT: "codex" });
    expect(fs.lstatSync(workspaceConfigPath(tmp)).isSymbolicLink()).toBe(true);
    expect(read(real)).toBe("SANDY_AGENT=codex\n");
  });

  it("shows SANDY_EXTRA_ENV as the union sandy forwards, across both files and duplicate lines", () => {
    const v = scopeView(extraSchema, "SANDY_EXTRA_ENV=FOO\nSANDY_EXTRA_ENV=BAR, FOO\n", "SANDY_EXTRA_ENV=BAZ\n");
    expect(v.values.SANDY_EXTRA_ENV).toBe("FOO,BAR,BAZ");
  });

  it("saving SANDY_EXTRA_ENV collapses every line into one, so nothing hidden survives or is lost", () => {
    write(workspaceConfigPath(tmp), "SANDY_EXTRA_ENV=FOO\n");
    write(workspaceSecretsPath(tmp), "SANDY_EXTRA_ENV=BAR\n");
    saveScope("workspace", tmp, extraSchema, { SANDY_EXTRA_ENV: "FOO,BAR,BAZ" });
    expect(read(workspaceConfigPath(tmp))).toBe("SANDY_EXTRA_ENV=FOO,BAR,BAZ\n");
    expect(read(workspaceSecretsPath(tmp))).toBe("");
  });

  it("collapses duplicate SANDY_EXTRA_ENV lines even when the last one already matches", () => {
    write(workspaceConfigPath(tmp), "SANDY_EXTRA_ENV=FOO\nSANDY_EXTRA_ENV=BAR\n");
    saveScope("workspace", tmp, extraSchema, { SANDY_EXTRA_ENV: "BAR" });
    expect(read(workspaceConfigPath(tmp))).toBe("SANDY_EXTRA_ENV=BAR\n");
  });
});
