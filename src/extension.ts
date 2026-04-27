import * as vscode from "vscode";
import * as cp from "child_process";
import * as os from "os";
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

    // Palette + tree-default-click
    vscode.commands.registerCommand("sandy.launch",        (arg) => openTerminalPanel(ctx, arg?.workspacePath)),
    vscode.commands.registerCommand("sandy.approval.test", () => runApprovalTest(ctx)),
    vscode.commands.registerCommand("sandy.settings.open", () => openSettingsPanel(ctx)),
    vscode.commands.registerCommand("sandy.state.refresh", () => poller.refresh()),

    // Tree right-click context menu — every handler receives the SandboxNode
    // (or whatever was right-clicked). VSCode passes it as the first arg.
    vscode.commands.registerCommand("sandy.tree.launch", (node: any) => {
      const ws = node?.sandbox?.workspace_path;
      if (!ws) {
        vscode.window.showWarningMessage("Sandy: this sandbox has no workspace_path — can't launch automatically. Use Open Workspace Folder, then Sandy: Launch from the palette.");
        return;
      }
      return openTerminalPanel(ctx, ws);
    }),
    vscode.commands.registerCommand("sandy.tree.openWorkspace", async (node: any) => {
      const ws = node?.sandbox?.workspace_path;
      if (!ws) return vscode.window.showWarningMessage("No workspace_path on this sandbox.");
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(ws), { forceNewWindow: false });
    }),
    vscode.commands.registerCommand("sandy.tree.openWorkspaceNewWin", async (node: any) => {
      const ws = node?.sandbox?.workspace_path;
      if (!ws) return vscode.window.showWarningMessage("No workspace_path on this sandbox.");
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(ws), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand("sandy.tree.revealSandbox", async (node: any) => {
      const sandboxPath = node?.sandbox?.path;
      if (!sandboxPath) return vscode.window.showWarningMessage("No sandbox path on this entry.");
      revealInOSFileManager(sandboxPath);
    }),
    vscode.commands.registerCommand("sandy.tree.copyWorkspacePath", async (node: any) => {
      const ws = node?.sandbox?.workspace_path;
      if (!ws) return vscode.window.showWarningMessage("No workspace_path on this sandbox.");
      await vscode.env.clipboard.writeText(ws);
      vscode.window.setStatusBarMessage(`Copied: ${ws}`, 3000);
    }),
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

// "Reveal in Finder/Explorer/file manager" — prefer VSCode's built-in command
// which already handles platform differences; fall back to OS-specific spawns
// if the command is unavailable for some reason.
function revealInOSFileManager(fsPath: string): void {
  const uri = vscode.Uri.file(fsPath);
  vscode.commands.executeCommand("revealFileInOS", uri).then(undefined, () => {
    // Fallback: shell out per-platform.
    const platform = os.platform();
    const cmd = platform === "darwin" ? "open"
              : platform === "win32"  ? "explorer"
                                      : "xdg-open";
    cp.spawn(cmd, [fsPath], { detached: true, stdio: "ignore" }).unref();
  });
}
