import * as vscode from "vscode";
import * as path from "path";
import { workspaceConfigPath, readKv } from "../settings/configIO";
import { validateConfig, ValidateResult } from "./validate";
import { openApprovalWebview } from "./webviewModal";

export interface PreflightResult {
  proceed: boolean;
  setApproveEnv: boolean;  // true → caller passes SANDY_AUTO_APPROVE_PRIVILEGED=1
  validation?: ValidateResult;
  error?: string;
}

const HEADER  = "Sandy: passive-privileged approval requested";
const SUBTEXT_PREFIX =
  "The following privileged keys are set in this workspace and require " +
  "explicit approval before sandy will use them. Review the raw values, then " +
  "Approve to launch this once, or Reject to abort.";

// Pre-launch validation + approval orchestration. Returns:
//   { proceed: true,  setApproveEnv: false } — no approval needed (or sandy
//                                              has already persisted approval)
//   { proceed: true,  setApproveEnv: true  } — user just approved via webview
//                                              modal; caller must set
//                                              SANDY_AUTO_APPROVE_PRIVILEGED=1
//                                              for THIS launch only
//   { proceed: false }                       — user rejected (or dismissed)
//
// Errors from sandy --validate-config are non-fatal: we proceed and let sandy
// itself enforce approval at launch time. The error is bubbled back so the
// caller can log it.
export async function checkPreflightApproval(
  ctx: vscode.ExtensionContext,
  workspaceFsPath: string,
): Promise<PreflightResult> {
  const configPath = workspaceConfigPath(workspaceFsPath);
  const { result, error } = await validateConfig(configPath);

  if (error || !result) {
    return { proceed: true, setApproveEnv: false, error };
  }

  const status = result.approval_status ?? "none_required";
  if (status !== "pending") {
    return { proceed: true, setApproveEnv: false, validation: result };
  }

  // Build the verbatim KEY=VALUE block from the workspace config, filtered to
  // the keys sandy says require approval. We read the user's config file
  // directly rather than relying on validate to echo values back, so what
  // the user sees in the modal is exactly what's on disk right now.
  const allKv = readKv(configPath);
  const keys = result.privileged_keys_requiring_approval ?? [];
  const lines = keys
    .map(k => k in allKv ? `${k}=${allKv[k]}` : `${k}=  (declared but not set in ${path.basename(configPath)})`)
    .join("\n");

  const decision = await openApprovalWebview(ctx, {
    header:  HEADER,
    subtext: SUBTEXT_PREFIX,
    body:    lines || "(sandy reported pending approval but listed no specific keys — please report this as a sandy-ui bug)",
  });

  if (decision === "approve") return { proceed: true,  setApproveEnv: true,  validation: result };
  return                          { proceed: false, setApproveEnv: false,    validation: result };
}
