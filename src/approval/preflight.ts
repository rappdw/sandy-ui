import * as vscode from "vscode";
import { buildPreview, ApprovalsReport } from "./report";
import { runApprovals, workspaceValues } from "./approvals";
import { openApprovalWebview } from "./webviewModal";

export interface PreflightResult {
  proceed: boolean;
  report?: ApprovalsReport;
  /** Why no report was used (logged; never blocks the launch). */
  note?: string;
}

// Before a launch: ask sandy what its approval gates would decide, and if any
// is unresolved, show a read-only preview, then let sandy ask in the terminal
// (decision C, ROADMAP_1.0.md). sandy-ui no longer approves anything itself:
// the old modal set SANDY_AUTO_APPROVE_PRIVILEGED=1 for the launch, which
// granted on the user's behalf what sandy's own prompt is there to ask.
//
// Never blocks a launch on its own failure: no `--approvals` (sandy < 2.7.0),
// no binary, or no report all just proceed — sandy enforces every gate itself.
export async function checkPreflight(
  ctx: vscode.ExtensionContext,
  workspace: string,
  sandyBin: string | undefined,
  hasApprovalsReport: boolean,
  env: NodeJS.ProcessEnv,
): Promise<PreflightResult> {
  if (!sandyBin) return { proceed: true, note: "sandy binary not resolved" };
  if (!hasApprovalsReport) return { proceed: true, note: "sandy has no --approvals (< 2.7.0); sandy will ask in the terminal" };

  const run = await runApprovals(sandyBin, workspace, env);
  if (!run.report) return { proceed: true, note: run.error };
  if (!run.report.complete) {
    return { proceed: true, report: run.report, note: `no verdict (${run.report.error ?? "incomplete"}); sandy will report the problem` };
  }

  const preview = buildPreview(run.report, workspaceValues(workspace));
  if (!preview) return { proceed: true, report: run.report };

  const decision = await openApprovalWebview(ctx, {
    header: preview.header,
    subtext: preview.subtext,
    body: preview.body,
    primary: preview.willRefuse ? "Launch anyway" : "Continue — answer in the terminal",
    secondary: "Cancel",
  });
  return { proceed: decision === "approve", report: run.report };
}
