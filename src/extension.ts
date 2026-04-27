import * as vscode from "vscode";
import { openTerminalPanel } from "./terminal/webviewPanel";
import { showApprovalNative } from "./approval/nativeModal";
import { openApprovalWebview } from "./approval/webviewModal";
import { openSettingsPanel } from "./settings/webviewPanel";
import { ProjectsTreeProvider } from "./projectsTree";
import { StatePoller } from "./state/poller";

export function activate(ctx: vscode.ExtensionContext) {
  const stateOut = vscode.window.createOutputChannel("Sandy State");
  const poller   = new StatePoller(/* intervalMs */ 5_000, stateOut);
  poller.start();

  const projects = new ProjectsTreeProvider(poller);

  ctx.subscriptions.push(
    poller,
    projects,
    stateOut,
    vscode.window.registerTreeDataProvider("sandy.projects", projects),
    vscode.commands.registerCommand("sandy.launch",        (arg) => openTerminalPanel(ctx, arg?.workspacePath)),
    vscode.commands.registerCommand("sandy.approval.test", () => runApprovalTest(ctx)),
    vscode.commands.registerCommand("sandy.settings.open", () => openSettingsPanel(ctx)),
    vscode.commands.registerCommand("sandy.state.refresh", () => poller.refresh()),
  );
}

export function deactivate() { /* webviews and PTYs dispose themselves; poller via subscriptions */ }

async function runApprovalTest(ctx: vscode.ExtensionContext) {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Native modal (showInformationMessage detail)", id: "native" },
      { label: "Webview-based modal",                          id: "webview" },
    ],
    { placeHolder: "Which approval-modal renderer do you want to test?" }
  );
  if (!choice) return;
  if (choice.id === "native") await showApprovalNative();
  else                        await openApprovalWebview(ctx);
}
