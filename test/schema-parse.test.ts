import { describe, it, expect } from "vitest";
import { parseSandySchema } from "../src/schema/parse";
import type { SandySchema } from "../src/schema/types";

const minimal: SandySchema = {
  schema_version: 1,
  sandy: { version: "0.12.0", commit: "abc1234" },
  config: {},
};

describe("parseSandySchema — top-level metadata", () => {
  it("propagates schema_version and sandy.version", () => {
    const result = parseSandySchema(minimal);
    expect(result.schema_version).toBe(1);
    expect(result.sandy_version).toBe("0.12.0");
  });

  it("falls back to 'unknown' when sandy.version missing", () => {
    const result = parseSandySchema({ ...minimal, sandy: { version: undefined as any } });
    expect(result.sandy_version).toBe("unknown");
  });

  it("returns empty fields[] when config has no key arrays", () => {
    expect(parseSandySchema(minimal).fields).toEqual([]);
  });
});

describe("parseSandySchema — privileged_keys", () => {
  it("flags every privileged key with privileged: true", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: {
        privileged_keys: [
          { name: "SANDY_SKIP_PERMISSIONS", type: "bool", default: true, description: "skip perms" },
          { name: "SANDY_ALLOW_LAN_HOSTS", type: "string", description: "allow LAN" },
        ],
      },
    };
    const fields = parseSandySchema(sandy).fields;
    expect(fields).toHaveLength(2);
    expect(fields[0]).toMatchObject({
      key: "SANDY_SKIP_PERMISSIONS",
      type: "bool",
      tier: "workspace",
      privileged: true,
      default: true,
    });
    expect(fields[1]).toMatchObject({
      key: "SANDY_ALLOW_LAN_HOSTS",
      privileged: true,
      tier: "workspace",
    });
  });
});

describe("parseSandySchema — passive_keys tier inference", () => {
  it("defaults passive keys to tier 'home'", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: { passive_keys: [{ name: "SANDY_AGENT", type: "agent_combo" }] },
    };
    const f = parseSandySchema(sandy).fields[0];
    expect(f.tier).toBe("home");
    expect(f.privileged).toBeUndefined();
  });

  it("routes type=secret to tier 'secrets' regardless of sources", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: { passive_keys: [{ name: "ANTHROPIC_API_KEY", type: "secret", sources: ["env"] }] },
    };
    expect(parseSandySchema(sandy).fields[0].tier).toBe("secrets");
  });

  it("routes sources=['home_secrets'] to tier 'secrets'", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: { passive_keys: [{ name: "TELEGRAM_BOT_TOKEN", type: "string", sources: ["home_secrets"] }] },
    };
    expect(parseSandySchema(sandy).fields[0].tier).toBe("secrets");
  });

  it("routes sources=['workspace_config'] only to tier 'workspace'", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: { passive_keys: [{ name: "SANDY_PROJECT_ONLY", type: "string", sources: ["workspace_config"] }] },
    };
    expect(parseSandySchema(sandy).fields[0].tier).toBe("workspace");
  });

  it("preserves passive_approval_required on passive keys (cross-tier privileged)", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: { passive_keys: [{ name: "WEIRD_BUT_PRIVILEGED", type: "string", passive_approval_required: true }] },
    };
    expect(parseSandySchema(sandy).fields[0].privileged).toBe(true);
  });
});

describe("parseSandySchema — field rename + value-mapping", () => {
  it("maps name → key, choices → options, all field types", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: {
        passive_keys: [
          { name: "SANDY_SSH", type: "enum", choices: ["token", "agent"], default: "token" },
          { name: "SANDY_TIMEOUT", type: "int", min: 30, max: 86400, default: 3600 },
          { name: "SANDY_MODEL", type: "string", pattern: "^[a-z0-9.-]+$", default: "claude" },
          { name: "SANDY_TELEMETRY", type: "bool", default: false },
        ],
      },
    };
    const fields = parseSandySchema(sandy).fields;
    expect(fields[0]).toMatchObject({ key: "SANDY_SSH", type: "enum", options: ["token", "agent"], default: "token" });
    expect(fields[1]).toMatchObject({ key: "SANDY_TIMEOUT", type: "int", min: 30, max: 86400, default: 3600 });
    expect(fields[2]).toMatchObject({ key: "SANDY_MODEL", pattern: "^[a-z0-9.-]+$" });
    expect(fields[3]).toMatchObject({ key: "SANDY_TELEMETRY", type: "bool", default: false });
  });
});

describe("parseSandySchema — env_only_keys are skipped", () => {
  it("does not surface env_only_keys to the form (they're not file-configurable)", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: {
        env_only_keys: [{ name: "SANDY_SECRET_ENV_ONLY", type: "string" }],
        passive_keys: [{ name: "SANDY_NORMAL", type: "string" }],
      },
    };
    const fields = parseSandySchema(sandy).fields;
    expect(fields).toHaveLength(1);
    expect(fields[0].key).toBe("SANDY_NORMAL");
  });
});

describe("parseSandySchema — capabilities.daemonMode (feature-detect via cli_flags)", () => {
  it("cli_flags containing {name:'--start'} → daemonMode true", () => {
    const sandy: SandySchema = { ...minimal, cli_flags: [{ name: "--attach" }, { name: "--start" }] };
    expect(parseSandySchema(sandy).capabilities).toEqual({ daemonMode: true });
  });

  it("absent cli_flags → daemonMode false", () => {
    expect(parseSandySchema(minimal).capabilities).toEqual({ daemonMode: false });
  });

  it("cli_flags present but without --start → daemonMode false", () => {
    const sandy: SandySchema = { ...minimal, cli_flags: [{ name: "--print-state" }, { name: "--print-schema" }] };
    expect(parseSandySchema(sandy).capabilities).toEqual({ daemonMode: false });
  });

  it("bare-string '--start' entry → daemonMode true", () => {
    const sandy: SandySchema = { ...minimal, cli_flags: ["--print-state", "--start"] };
    expect(parseSandySchema(sandy).capabilities).toEqual({ daemonMode: true });
  });
});

describe("parseSandySchema — multi-tier flat output ordering", () => {
  it("emits privileged keys first, then passive (preserves array order within each)", () => {
    const sandy: SandySchema = {
      ...minimal,
      config: {
        privileged_keys: [
          { name: "PRIV_A", type: "bool" },
          { name: "PRIV_B", type: "bool" },
        ],
        passive_keys: [
          { name: "PASS_A", type: "string" },
          { name: "PASS_B", type: "string" },
        ],
      },
    };
    const keys = parseSandySchema(sandy).fields.map(f => f.key);
    expect(keys).toEqual(["PRIV_A", "PRIV_B", "PASS_A", "PASS_B"]);
  });
});
