import * as cp from "child_process";
import * as path from "path";
import { parseSandyJson } from "../state/parseJson";
import { readSandyKv } from "../settings/configIO";
import { ApprovalsReport, asApprovalsReport, KeyValueSource, looksSecret } from "./report";

export interface ApprovalsRun { report?: ApprovalsReport; exitCode?: number; error?: string }

/**
 * Run `sandy --approvals --workspace <ws>`. Exit 0 = nothing unresolved,
 * 2 = something unresolved, 1 = no report; stdout carries one JSON document
 * in every case. Pass the environment the launch will use: sandy skips keys
 * the environment already sets, so the verdict depends on it.
 */
export function runApprovals(sandyBin: string, workspace: string, env: NodeJS.ProcessEnv): Promise<ApprovalsRun> {
  return new Promise((resolve) => {
    cp.execFile(sandyBin, ["--approvals", "--workspace", workspace], {
      encoding: "utf8", timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env,
    }, (err, stdout) => {
      const exitCode = typeof (err as { code?: unknown } | null)?.code === "number"
        ? (err as { code: number }).code : err ? undefined : 0;
      let report: ApprovalsReport | undefined;
      try { report = asApprovalsReport(parseSandyJson<unknown>(stdout)); } catch { /* reported below */ }
      if (report) resolve({ report, exitCode });
      else resolve({ exitCode, error: err?.message || "sandy --approvals produced no report" });
    });
  });
}

/**
 * Values for the preview, from the workspace's own files as sandy reads them
 * (.sandy/.secrets is loaded after .sandy/config, so it wins). Anything from
 * .secrets, or named like a credential, is marked secret and masked.
 */
export function workspaceValues(workspace: string): (key: string) => KeyValueSource {
  const config  = readSandyKv(path.join(workspace, ".sandy", "config"));
  const secrets = readSandyKv(path.join(workspace, ".sandy", ".secrets"));
  return (key) => {
    if (key in secrets) return { value: secrets[key], file: ".sandy/.secrets", secret: true };
    if (key in config)  return { value: config[key],  file: ".sandy/config",   secret: looksSecret(key) };
    return { secret: looksSecret(key) };
  };
}
