import * as vscode from "vscode";
import * as cp from "child_process";
import * as os from "os";
import { openTerminalPanel } from "./terminal/webviewPanel";
import { showApprovalNative } from "./approval/nativeModal";
import { openApprovalWebview } from "./approval/webviewModal";
import { openSettingsPanel } from "./settings/webviewPanel";
import { ProjectsTreeProvider } from "./projectsTree";
import { StatePoller } from "./state/poller";
import { deleteSandboxDir, removeLockForSandbox, lockPathForSandbox } from "./state/deleteSandbox";

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
    vscode.commands.registerCommand("sandy.tree.removeLock", async (node: any) => {
      const sb = node?.sandbox;
      if (!sb?.name) return vscode.window.showWarningMessage("Sandy: no sandbox name on this entry — nothing to unlock.");

      // Refuse if a container is actively running for this sandbox — the lock
      // is real, removing it would let a second sandy spawn against the same
      // container/network and corrupt state.
      const cur = poller.current();
      const isRunning = !!cur.state?.running_containers?.some(c => c.sandbox === sb.name);
      if (isRunning) {
        vscode.window.showErrorMessage(
          `Sandy: sandbox "${sb.name}" has a running container — the lock is real, not stale. Stop sandy in this workspace first.`
        );
        return;
      }

      const lockPath = lockPathForSandbox(sb.name);
      const holderPid = sb.lock_holder_pid;
      const choice = await vscode.window.showWarningMessage(
        `Remove lock for "${sb.name}"?`,
        {
          modal: true,
          detail:
            `This deletes the lock file:\n  ${lockPath}\n\n` +
            (holderPid != null
              ? `The lock claims to be held by PID ${holderPid}. If that process is actually alive and using sandy, removing this lock is dangerous.\n\n`
              : `No PID is recorded in the lock — likely a leftover from a crashed sandy.\n\n`) +
            `Sandbox files and any approval records are NOT touched. The next sandy launch will re-acquire the lock cleanly.`,
        },
        "Remove Lock"
      );
      if (choice !== "Remove Lock") return;

      const result = removeLockForSandbox(sb.name);
      if (result.ok) {
        vscode.window.setStatusBarMessage(`Removed lock for: ${sb.name}`, 5000);
        stateOut.appendLine(`[${new Date().toISOString()}] removed lock: ${result.removedPath}`);
        void poller.refresh();
      } else {
        vscode.window.showErrorMessage(`Sandy: remove lock failed — ${result.error}`);
      }
    }),
    vscode.commands.registerCommand("sandy.tree.deleteSandbox", async (node: any) => {
      const sb = node?.sandbox;
      if (!sb?.path) return vscode.window.showWarningMessage("Sandy: no sandbox path on this entry — nothing to delete.");

      // Refuse to delete a running sandbox — the container would orphan and
      // the next launch would fail. Force the user to stop it first.
      const cur = poller.current();
      const isRunning = !!cur.state?.running_containers?.some(c => c.sandbox === sb.name);
      if (isRunning) {
        vscode.window.showErrorMessage(
          `Sandy: sandbox "${sb.name}" is currently running. Stop sandy in this workspace first, then try Delete again.`
        );
        return;
      }

      // Modal confirmation. detail field carries the full path so the user
      // sees exactly what's about to be removed; "Delete" is the only action
      // — Cancel is the default (Esc / click outside).
      const choice = await vscode.window.showWarningMessage(
        `Delete sandbox "${sb.name}"?`,
        {
          modal: true,
          detail:
            `This permanently removes the sandbox directory:\n` +
            `  ${sb.path}\n\n` +
            `Workspace folder is NOT touched: ${sb.workspace_path ?? "(unknown)"}\n\n` +
            `If sandy left Docker resources behind (network, image), they are NOT cleaned by this action — run \`docker system prune\` separately if needed.\n\n` +
            `This cannot be undone.`,
        },
        "Delete"
      );
      if (choice !== "Delete") return;

      const result = deleteSandboxDir(sb.path);
      if (result.ok) {
        vscode.window.setStatusBarMessage(`Deleted sandbox: ${sb.name}`, 5000);
        stateOut.appendLine(`[${new Date().toISOString()}] deleted sandbox: ${result.removedPath}`);
        void poller.refresh();
      } else {
        vscode.window.showErrorMessage(`Sandy: delete failed — ${result.error}`);
      }
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
