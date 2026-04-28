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
import { invalidateSandyPathCache } from "./state/sandyPath";
import { PtySupervisor } from "./terminal/supervisor";

// Module-level so deactivate() can reach the supervisor (deactivate doesn't
// receive ctx in the same way activate does, and the supervisor needs
// to drive shutdown across all live sessions).
let supervisor: PtySupervisor | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  const stateOut = vscode.window.createOutputChannel("Sandy State");
  const poller   = new StatePoller(/* intervalMs */ 5_000, stateOut);
  poller.start();

  supervisor = new PtySupervisor(stateOut);

  const projects = new ProjectsTreeProvider(poller, supervisor);

  // Honor a pending launch from a previous-window tree click. When the user
  // clicks a tree item for a different workspace, we openFolder (which
  // reloads VSCode) and stash a marker here; on activation in the new
  // workspace we pick it up and fire sandy.launch automatically.
  void resumePendingLaunchIfAny(ctx, stateOut);

  ctx.subscriptions.push(
    poller,
    projects,
    supervisor,
    stateOut,
    // If the user updates sandy.binaryPath at runtime, invalidate the
    // resolver cache and trigger a state refresh so the new value is used.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("sandy.binaryPath")) {
        invalidateSandyPathCache();
        void poller.refresh();
      }
    }),
    vscode.window.registerTreeDataProvider("sandy.projects", projects),

    // Palette + tree-default-click. If the target workspace differs from the
    // current one, we openFolder (reloads VSCode), persist a pending-launch
    // marker, and let resumePendingLaunchIfAny finish the job after reload.
    vscode.commands.registerCommand("sandy.launch", (arg) => launchWithWorkspaceSwitch(ctx, arg?.workspacePath, stateOut)),
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
      return launchWithWorkspaceSwitch(ctx, ws, stateOut);
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
    vscode.commands.registerCommand("sandy.tree.detach", async (node: any) => {
      const ws = node?.sandbox?.workspace_path;
      if (!ws || !supervisor) return;
      const session = supervisor.getSession(ws);
      if (!session) {
        vscode.window.showInformationMessage(`Sandy: no live session for ${ws} — nothing to detach.`);
        return;
      }
      const panel = session.panel;
      // Order matters: clear session.panel BEFORE disposing the panel so
      // the panel-dispose handler in webviewPanel.ts sees the detached state
      // and skips the kill-the-PTY path.
      supervisor.detach(ws);
      try { panel?.dispose(); } catch { /* swallow */ }
      vscode.window.setStatusBarMessage(`Sandy: detached session for ${ws} (sandy still running)`, 5_000);
    }),
    vscode.commands.registerCommand("sandy.tree.stop", async (node: any) => {
      const ws = node?.sandbox?.workspace_path;
      if (!ws || !supervisor) return;
      const session = supervisor.getSession(ws);
      if (!session) {
        vscode.window.showInformationMessage(`Sandy: no live session for ${ws}.`);
        return;
      }
      vscode.window.setStatusBarMessage(`Sandy: stopping ${ws}…`, 5_000);
      await supervisor.stop(ws);
      try { session.panel?.dispose(); } catch { /* swallow */ }
      void poller.refresh();
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

// VSCode awaits the Promise returned from deactivate() (~5s budget) before
// killing the extension host. Delegate to the supervisor which parallel-
// SIGINTs every live session — cleanup traps (docker stop, docker network
// rm) run concurrently rather than serially via per-tab onDidDispose.
export async function deactivate(): Promise<void> {
  await supervisor?.disposeAll();
}

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

// ---------------------------------------------------------------------------
// Workspace-aware launch: if the requested workspace differs from the current
// VSCode workspace folder, openFolder (which reloads VSCode) and queue the
// launch for after-reload via globalState. Otherwise just launch.
// ---------------------------------------------------------------------------

const PENDING_LAUNCH_KEY = "sandy.pendingLaunch";
const PENDING_LAUNCH_TTL_MS = 30_000;  // generous; reload + activate usually <5s

interface PendingLaunch {
  workspace: string;
  at: number;
}

async function launchWithWorkspaceSwitch(
  ctx: vscode.ExtensionContext,
  targetWs: string | undefined,
  out: vscode.OutputChannel,
): Promise<void> {
  if (!supervisor) return;  // not activated yet (shouldn't happen in practice)
  // No target — defer to openTerminalPanel which prompts for a folder.
  if (!targetWs) return openTerminalPanel(ctx, supervisor, undefined);

  const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (currentWs && currentWs === targetWs) {
    // Already in the right workspace — just launch (or re-attach if a
    // detached session exists for this workspace).
    return openTerminalPanel(ctx, supervisor, targetWs);
  }

  if (!currentWs) {
    // No folder open at all — no reload needed; openTerminalPanel will use
    // the override directly. (Equivalent to "Launch here" in an empty window.)
    return openTerminalPanel(ctx, supervisor, targetWs);
  }

  // Workspace mismatch — switch by openFolder (reloads VSCode), and persist
  // a pending-launch marker so resumePendingLaunchIfAny picks it up after
  // the new workspace activates.
  const pending: PendingLaunch = { workspace: targetWs, at: Date.now() };
  await ctx.globalState.update(PENDING_LAUNCH_KEY, pending);
  out.appendLine(`[${new Date().toISOString()}] workspace switch: ${currentWs} → ${targetWs} (pending launch queued)`);
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetWs), { forceNewWindow: false });
  // Execution doesn't continue past openFolder in practice — VSCode reloads.
}

async function resumePendingLaunchIfAny(
  ctx: vscode.ExtensionContext,
  out: vscode.OutputChannel,
): Promise<void> {
  const pending = ctx.globalState.get<PendingLaunch>(PENDING_LAUNCH_KEY);
  if (!pending) return;

  // Always clear on activation, even if we don't end up firing — stale
  // markers (e.g., user cancelled the openFolder dialog) shouldn't persist.
  await ctx.globalState.update(PENDING_LAUNCH_KEY, undefined);

  const ageMs = Date.now() - pending.at;
  if (ageMs > PENDING_LAUNCH_TTL_MS) {
    out.appendLine(`[${new Date().toISOString()}] discarding stale pending launch (${Math.round(ageMs / 1000)}s old)`);
    return;
  }

  const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (currentWs !== pending.workspace) {
    out.appendLine(`[${new Date().toISOString()}] discarding pending launch — current workspace ${currentWs} ≠ target ${pending.workspace}`);
    return;
  }

  // Brief delay so VSCode's tree/editor finish settling before we open a
  // webview tab. Not strictly required but produces a less jarring sequence.
  out.appendLine(`[${new Date().toISOString()}] resuming pending launch in ${pending.workspace}`);
  setTimeout(() => {
    void vscode.commands.executeCommand("sandy.launch", { workspacePath: pending.workspace });
  }, 500);
}
