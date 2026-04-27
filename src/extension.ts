import * as vscode from "vscode";
import { openTerminalPanel } from "./terminal/webviewPanel";
import { showApprovalNative } from "./approval/nativeModal";
import { openApprovalWebview } from "./approval/webviewModal";
import { openSettingsPanel } from "./settings/webviewPanel";
import { ProjectsTreeProvider } from "./projectsTree";

export function activate(ctx: vscode.ExtensionContext) {
  const projects = new ProjectsTreeProvider();
  ctx.subscriptions.push(
    vscode.window.registerTreeDataProvider("sandy.projects", projects),
    vscode.commands.registerCommand("sandy.launch",        () => openTerminalPanel(ctx)),
    vscode.commands.registerCommand("sandy.approval.test", () => runApprovalTest(ctx)),
    vscode.commands.registerCommand("sandy.settings.open", () => openSettingsPanel(ctx)),
  );
}

export function deactivate() { /* webviews and PTYs dispose themselves */ }

async function runApprovalTest(ctx: vscode.ExtensionContext) {
  // Try the native modal first; on user request fall back to webview.
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
