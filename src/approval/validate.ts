import * as cp from "child_process";
import * as fs from "fs";

// `sandy --validate-config PATH` JSON shape per SPEC_INTROSPECTION.md.
// Optional fields wherever the spec allows additive change.

export type ApprovalStatus = "pending" | "approved" | "none_required";
export type Severity = "error" | "warning" | "info";

export interface ValidateWarning {
  key?: string;
  message: string;
  severity: Severity;
}

export interface ValidateResult {
  schema_version: number;
  path?: string;
  source_tier?: "home" | "workspace";
  errors?: ValidateWarning[];
  warnings?: ValidateWarning[];
  unknown_keys?: string[];
  privileged_keys_requiring_approval?: string[];
  approval_status?: ApprovalStatus;
  approval_file_path?: string;
}

export interface ValidateResolution {
  result?: ValidateResult;
  error?: string;
}

// Run the validate. Resolves with `error` set when sandy isn't reachable,
// when the config doesn't exist (sandy returns non-zero exit), or when the
// JSON parse fails. Caller decides what to do with errors — typically
// proceed-with-launch and let sandy itself enforce approval.
export function validateConfig(configPath: string): Promise<ValidateResolution> {
  return new Promise<ValidateResolution>((resolve) => {
    if (!fs.existsSync(configPath)) {
      // No config file = nothing to validate. Treat as "no approval needed."
      resolve({ result: { schema_version: 1, approval_status: "none_required" } });
      return;
    }
    cp.execFile("sandy", ["--validate-config", configPath], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => {
      // Sandy emits JSON on both success (exit 0, with warnings) and on
      // schema-load failures (exit 0); only fatal-fatal errors give exit 1
      // per the spec. Try to parse stdout regardless of err.
      let parsed: ValidateResult | undefined;
      if (stdout) {
        try { parsed = JSON.parse(stdout) as ValidateResult; }
        catch { /* fall through to error reporting */ }
      }
      if (parsed) {
        resolve({ result: parsed });
        return;
      }
      const code = (err as NodeJS.ErrnoException | null)?.code;
      const msg = code === "ENOENT" ? "sandy not on PATH" : (err?.message || "validate-config produced no JSON");
      resolve({ error: msg });
    });
  });
}
