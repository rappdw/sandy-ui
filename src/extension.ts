import * as vscode from "vscode";
import * as cp from "child_process";
import * as os from "os";
import * as path from "path";
import { openTerminalPanel } from "./terminal/webviewPanel";
import { showApprovalNative } from "./approval/nativeModal";
import { openApprovalWebview } from "./approval/webviewModal";
import { openSettingsPanel } from "./settings/webviewPanel";
import { ProjectsTreeProvider } from "./projectsTree";
import { StatePoller } from "./state/poller";
import { pollCadence } from "./state/cadence";
import { deleteSandboxDir, removeLockForSandbox, lockPathForSandbox } from "./state/deleteSandbox";
import { invalidateSandyPathCache, resolveSandyBinary } from "./state/sandyPath";
import { daemonInfoFor, findLongRunners, formatAge, persistedSessionForWorkspace } from "./state/badge";
import { pruneOrphansArgs, stopArgs, STOP_EXIT } from "./daemon/contract";
import { PtySupervisor, Session } from "./terminal/supervisor";
import { runSynthkitCommand } from "./synthkit/commands";
import { getCachedSchema } from "./schema/cache";
import { evaluateCompat, describeVerdict, SANDY_MIN_VERSION, SUPPORTED_SCHEMA_VERSIONS } from "./schema/compat";
import { deriveDoctorStatus, DoctorStatus } from "./doctor";
import type { Schema } from "./settings/configIO";
import schemaMock from "./mocks/schema.json";

// Module-level so deactivate() can reach the supervisor (deactivate doesn't
// receive ctx in the same way activate does, and the supervisor needs
// to drive shutdown across all live sessions).
let supervisor: PtySupervisor | undefined;

export function activate(ctx: vscode.ExtensionContext) {
  const stateOut = vscode.window.createOutputChannel("Sandy State");
  const poller   = new StatePoller(stateOut);
  // Cadence is driven by tree-view visibility + window focus (wired below,
  // after the tree view exists) — no unconditional polling. Every VSCode
  // window used to poll `sandy --print-state` (≈9 docker spawns) every 5s
  // forever, which showed up as a sawtooth CPU pattern on macOS.

  // Synthkit (md2email/md2doc/md2pdf right-click integration) gets its own
  // output channel — its activity is unrelated to sandy state polling.
  const synthkitOut = vscode.window.createOutputChannel("Synthkit");

  supervisor = new PtySupervisor(stateOut);

  const projects = new ProjectsTreeProvider(poller, supervisor);

  // createTreeView (not registerTreeDataProvider) so we get the visibility
  // signal that gates polling.
  const treeView = vscode.window.createTreeView("sandy.projects", { treeDataProvider: projects });
  const updateCadence = () =>
    poller.setCadence(pollCadence(treeView.visible, vscode.window.state.focused));
  updateCadence();

  // Status bar item: count of running sandy sessions, click → quick-pick to
  // switch tabs. Hides when no sessions are live so it doesn't clutter the
  // status bar of users not currently using sandy. Right-aligned because
  // the left side is conventionally for editor/file context.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "sandy.statusbar.click";
  // Daemon-aware: a persisted session (host-side sandy daemon, no local
  // client) has no supervisor entry at all — supervisor.detach() drops
  // daemon sessions from its map synchronously (see PtySupervisor.detach's
  // daemon branch), so "persisted" means "poller reports a daemon container
  // whose workspace the supervisor doesn't know about". Counted alongside
  // local sessions so the bar shows even when every daemon session's client
  // has gone away — the old "hide when supervisor is empty" behavior would
  // otherwise hide a bar that should say "1 sandy, persisted".
  const refreshStatusBar = () => {
    if (!supervisor) return;
    const sessions = supervisor.getAllSessions();
    const detachedCount = sessions.filter(s => !s.panel).length;
    const supervisorWorkspaces = new Set(sessions.map(s => s.workspacePath));
    const state = poller.current().state;
    const persisted = (state?.running_containers ?? [])
      .filter(c => c.daemon === true)
      .map(c => ({ c, ws: state?.sandboxes.find(sb => sb.name === c.sandbox)?.workspace_path }))
      .filter((x): x is { c: typeof x.c; ws: string } => !!x.ws && !supervisorWorkspaces.has(x.ws));

    const total = sessions.length + persisted.length;
    if (total === 0) { statusBar.hide(); return; }
    // One combined "detached" count (direct-backend detached + persisted
    // daemon sessions) — keeps the label simple rather than juggling two
    // suffixes for what's the same "not attached right now" concept.
    const detachedTotal = detachedCount + persisted.length;
    statusBar.text = `$(server-process) ${total} sandy`
      + (detachedTotal > 0 ? ` ($(eye-closed) ${detachedTotal} detached)` : "");
    statusBar.tooltip = [
      ...sessions.map(s => `${s.workspacePath}  •  ${s.panel ? "attached" : "detached"}  •  pid=${s.pty.pid}`),
      ...persisted.map(({ ws, c }) => {
        const age = c.started_at ? formatAge(c.started_at) : undefined;
        return `${ws}  •  persisted  •  ${c.attached_clients ?? "?"} client(s)` + (age ? ` · up ${age}` : "");
      }),
    ].join("\n");
    statusBar.show();
  };
  refreshStatusBar();

  // Long-running-session nudge (rappdw/sandy-ui#26): at most once per window
  // session, notify about persisted daemon sessions older than
  // sandy.longRunningSessionHours (0 disables). Deliberately a plain local —
  // not globalState — so a fresh VSCode window nudges again; the goal is
  // "don't nag repeatedly within one long-lived window", not "ever".
  let longRunnerNudged = false;

  // Snapshot the pending-launch marker BEFORE resume consumes it. VSCode's
  // Memento.update wipes the in-memory value synchronously, so by the time
  // maybeRestoreSession runs the marker is already gone — auto-restore's
  // "did a cross-window launch already claim this workspace?" guard has to
  // read the pre-resume value or it always sees undefined and double-opens
  // (batch-2 verify finding 1).
  const pendingAtActivation = ctx.globalState.get<PendingLaunch>(PENDING_LAUNCH_KEY);

  // Honor a pending launch from a previous-window tree click. When the user
  // clicks a tree item for a different workspace, we openFolder (which
  // reloads VSCode) and stash a marker here; on activation in the new
  // workspace we pick it up and fire sandy.launch automatically.
  void resumePendingLaunchIfAny(ctx, stateOut);

  // Compatibility gate (rappdw/sandy-ui#30 / SPEC_SANDY_UI.md §Compatibility).
  // Fire-and-forget: informs, never blocks — activation proceeds regardless,
  // and launch itself still works (sandy enforces its own compatibility at
  // runtime), matching the existing "let sandy handle it" precedent used for
  // --validate-config failures.
  void runCompatCheck(ctx, stateOut);

  // Doctor checks driving the "Sandy: Get Started" walkthrough's fix-it
  // steps (rappdw/sandy-ui#31): sets sandy.doctor.sandyOk / dockerOk context
  // keys from the same schema resolution + poller state the other startup
  // checks already use. Runs once now, and again on every poll change so the
  // walkthrough ticks live as the user installs sandy / starts Docker
  // without needing a reload.
  void runDoctorChecks(ctx, poller, stateOut);

  // Opt-in auto-restore of persisted daemon sessions on window open
  // (rappdw/sandy-ui#32). Gets the pre-resume marker snapshot so it can
  // defer to resumePendingLaunchIfAny when a cross-window launch already
  // owns this workspace. Also passes ctx back in (rappdw/sandy-ui#31) so it
  // can read the sandy.hasLaunched first-run gate.
  void maybeRestoreSession(ctx, pendingAtActivation, poller, stateOut);

  ctx.subscriptions.push(
    poller,
    projects,
    supervisor,
    stateOut,
    statusBar,
    supervisor.onDidChange(refreshStatusBar),
    // Persisted daemon sessions live in poller state, not the supervisor —
    // the bar needs to react to poll results too, not just local spawn/
    // attach/detach/exit events.
    poller.onDidChange(refreshStatusBar),
    // Re-run doctor checks on every poll change so the walkthrough's
    // checkDocker step (and sandyOk, in case sandy.binaryPath changed) ticks
    // off live rather than only at activation.
    poller.onDidChange(() => void runDoctorChecks(ctx, poller, stateOut)),
    // Long-running-session nudge — see longRunnerNudged declaration above.
    // Reads the threshold at fire time (not cached) so a mid-session
    // settings change takes effect on the next poll without a reload.
    poller.onDidChange((res) => {
      const threshold = vscode.workspace.getConfiguration("sandy").get<number>("longRunningSessionHours", 24);
      if (threshold <= 0 || longRunnerNudged || !res.state) return;
      const longRunners = findLongRunners(res.state.running_containers, res.state.sandboxes ?? [], threshold);
      if (longRunners.length === 0) return;
      longRunnerNudged = true;
      if (longRunners.length === 1) {
        const r = longRunners[0];
        const label = path.basename(r.workspacePath ?? r.sandboxName);
        // Without a workspace_path there is nothing either action can do —
        // Attach needs it for sandy.launch and the tree.stop handler bails
        // without it (batch-2 verify finding 1). Inform without offering
        // dead buttons; the user can act from a terminal.
        const actions = r.workspacePath ? ["Attach", "Stop"] : [];
        void vscode.window.showInformationMessage(
          `Sandy: session for ${label} has been running ${r.age}.`,
          ...actions,
        ).then((choice) => {
          if (choice === "Attach" && r.workspacePath) {
            void vscode.commands.executeCommand("sandy.launch", { workspacePath: r.workspacePath });
          } else if (choice === "Stop") {
            void vscode.commands.executeCommand("sandy.tree.stop", { sandbox: { name: r.sandboxName, workspace_path: r.workspacePath } });
          }
        });
      } else {
        void vscode.window.showInformationMessage(
          `Sandy: ${longRunners.length} persisted sessions running longer than ${threshold}h.`,
          "Show Sessions",
        ).then((choice) => {
          if (choice === "Show Sessions") void vscode.commands.executeCommand("sandy.statusbar.click");
        });
      }
    }),
    // If the user updates sandy.binaryPath at runtime, invalidate the
    // resolver cache and trigger a state refresh so the new value is used.
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration("sandy.binaryPath")) {
        invalidateSandyPathCache();
        void poller.refresh();
      }
    }),
    treeView,
    treeView.onDidChangeVisibility(updateCadence),
    vscode.window.onDidChangeWindowState(updateCadence),

    // Palette + tree-default-click. If the target workspace differs from the
    // current one, we openFolder (reloads VSCode), persist a pending-launch
    // marker, and let resumePendingLaunchIfAny finish the job after reload.
    vscode.commands.registerCommand("sandy.launch", (arg) =>
      launchWithWorkspaceSwitch(ctx, arg?.workspacePath, stateOut)),
    vscode.commands.registerCommand("sandy.walkthrough.open", () =>
      vscode.commands.executeCommand("workbench.action.openWalkthrough", "rappdw.sandy-ui#sandy.gettingStarted", false)
    ),
    // Button-driven from the persistence walkthrough step's "Got it" link
    // (command:sandy.walkthrough.ackPersistence) — not palette-worthy on its
    // own, but harmless to have there. Sets the context key the step's
    // completionEvent watches, and a separate first-run-complete marker
    // (distinct from sandy.hasLaunched — this one specifically means "the
    // user has seen and acknowledged the persistence semantics").
    vscode.commands.registerCommand("sandy.walkthrough.ackPersistence", () => {
      void vscode.commands.executeCommand("setContext", "sandy.walkthrough.persistenceRead", true);
      void ctx.globalState.update("sandy.firstRunComplete", true);
    }),
    vscode.commands.registerCommand("sandy.approval.test", () => runApprovalTest(ctx)),
    vscode.commands.registerCommand("sandy.settings.open", () => openSettingsPanel(ctx)),
    vscode.commands.registerCommand("sandy.state.refresh", () => poller.refresh()),

    // Prune orphaned sandy_* networks (rappdw/sandy#20). Reachable from the
    // palette and from the tree's "N orphaned sandy networks" status node.
    vscode.commands.registerCommand("sandy.pruneOrphans", () => {
      const sandyBin = resolveSandyBinary();
      if (!sandyBin) {
        vscode.window.showWarningMessage("Sandy: sandy binary not found — can't prune orphaned networks.");
        return;
      }
      cp.execFile(sandyBin, pruneOrphansArgs(), { timeout: 30_000 }, (err: any) => {
        if (!err) {
          vscode.window.setStatusBarMessage("Sandy: orphaned networks pruned", 5_000);
          void poller.refresh();
          return;
        }
        // Contract: exit 1 = docker unreachable.
        vscode.window.showErrorMessage(`Sandy: prune orphaned networks failed (exit ${err.code ?? "?"})`);
      });
    }),

    // Status bar click: quick-pick to switch between live sandy sessions.
    // Selecting a session reveals its panel if attached, or invokes launch
    // (which re-attaches a new panel to the live PTY) if detached.
    vscode.commands.registerCommand("sandy.statusbar.click", async () => {
      if (!supervisor) return;
      const sessions = supervisor.getAllSessions();
      const supervisorWorkspaces = new Set(sessions.map(s => s.workspacePath));
      const state = poller.current().state;
      const persisted = (state?.running_containers ?? [])
        .filter(c => c.daemon === true)
        .map(c => ({ c, ws: state?.sandboxes.find(sb => sb.name === c.sandbox)?.workspace_path }))
        .filter((x): x is { c: typeof x.c; ws: string } => !!x.ws && !supervisorWorkspaces.has(x.ws));

      if (sessions.length === 0 && persisted.length === 0) {
        vscode.window.showInformationMessage("Sandy: no live sessions.");
        return;
      }

      interface QuickPickSessionItem extends vscode.QuickPickItem {
        workspacePath: string;
        session?: Session;
      }
      const localItems: QuickPickSessionItem[] = sessions.map(s => ({
        label: `$(${s.panel ? "terminal" : "eye-closed"}) ${path.basename(s.workspacePath)}`,
        description: s.workspacePath,
        detail: s.panel ? `attached  •  pid=${s.pty.pid}` : `detached  •  pid=${s.pty.pid}  •  click to re-attach`,
        workspacePath: s.workspacePath,
        session: s,
      }));
      // Persisted daemon sessions have no local session object — picking
      // one goes straight through sandy.launch, which resolves to the
      // daemon path's --start (idempotent no-op) + --attach.
      const persistedItems: QuickPickSessionItem[] = persisted.map(({ ws, c }) => ({
        label: `$(eye-closed) ${path.basename(ws)}`,
        description: ws,
        detail: `persisted  •  ${c.attached_clients ?? "?"} client(s)  •  click to attach`,
        workspacePath: ws,
      }));
      const items = [...localItems, ...persistedItems];

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `${items.length} live sandy session${items.length === 1 ? "" : "s"} — pick to switch / re-attach`,
      });
      if (!picked) return;
      if (picked.session?.panel) {
        picked.session.panel.reveal(picked.session.panel.viewColumn ?? vscode.ViewColumn.Active, /* preserveFocus */ false);
      } else {
        // Detached (or persisted) — re-attach by invoking the normal launch
        // flow with the workspace override; openTerminalPanel detects the
        // existing session (direct) or the daemon path (persisted) and
        // rebinds.
        await vscode.commands.executeCommand("sandy.launch", { workspacePath: picked.workspacePath });
      }
    }),

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
        // Covers both "never launched" and daemon sessions whose local
        // client already went away (tab close / detach) — the supervisor
        // only tracks local clients for daemon sessions, so "no session
        // here" doesn't mean the host-side sandy session is gone.
        vscode.window.showInformationMessage(`Sandy: nothing to detach for ${ws} — daemon sessions without a client are already detached; launch to re-attach.`);
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
        // No local session — but a persisted daemon session (no local
        // client) can still be live on the host. Fall back to
        // `sandy --stop` directly rather than reporting "no live session"
        // for a session that's very much alive.
        const daemonInfo = daemonInfoFor(node?.sandbox?.name, poller.current().state?.running_containers ?? null);
        if (!daemonInfo) {
          vscode.window.showInformationMessage(`Sandy: no live session for ${ws}.`);
          return;
        }
        const sandyBin = resolveSandyBinary();
        if (!sandyBin) {
          vscode.window.showWarningMessage("Sandy: sandy binary not found — can't stop the daemon session.");
          return;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "Stopping sandy (daemon)…" },
          () => new Promise<void>((resolve) => {
            cp.execFile(sandyBin, stopArgs(ws), { timeout: 60_000 }, (err: any) => {
              if (!err) {
                vscode.window.setStatusBarMessage(`Sandy: stopped ${ws}`, 5_000);
              } else if (err.code === STOP_EXIT.NO_SESSION) {
                vscode.window.showInformationMessage(`Sandy: no such daemon session for ${ws}.`);
              } else {
                vscode.window.showErrorMessage(`Sandy: stop failed for ${ws} (exit ${err.code ?? "?"})`);
              }
              void poller.refresh();
              resolve();
            });
          }),
        );
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

    // Synthkit md2{email,doc,pdf} for .md files. Argument is a Uri when
    // invoked from explorer/context or editor/title/context; for palette
    // and editor/context the module falls back to the active editor URI.
    synthkitOut,
    vscode.commands.registerCommand("sandy.synthkit.md2email", (arg) => runSynthkitCommand("md2email", arg, synthkitOut)),
    vscode.commands.registerCommand("sandy.synthkit.md2doc",   (arg) => runSynthkitCommand("md2doc",   arg, synthkitOut)),
    vscode.commands.registerCommand("sandy.synthkit.md2pdf",   (arg) => runSynthkitCommand("md2pdf",   arg, synthkitOut)),
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
  // First-run marker for the auto-restore gate (rappdw/sandy-ui#31, Part C):
  // a profile that has never actually launched sandy shouldn't have
  // restoreSessionsOnStartup auto-open a session on a later window open. Set
  // here — the common path for ALL launch entry points (sandy.launch,
  // sandy.tree.launch, status-bar re-attach) — not just the sandy.launch
  // command, so a tree-only user still flips it (batch-3 gap).
  void ctx.globalState.update("sandy.hasLaunched", true);
  // No target — defer to openTerminalPanel which prompts for a folder.
  if (!targetWs) return openTerminalPanel(ctx, supervisor, undefined);

  // A live session (attached or detached) for the target already exists in
  // THIS extension host — attach in place, regardless of which folder VSCode
  // has open. The old path fell through to vscode.openFolder for a workspace
  // mismatch, and the window reload killed the extension host AND the PTY:
  // "re-attach" destroyed the very session it promised to restore (B5).
  if (supervisor.getSession(targetWs)) {
    return openTerminalPanel(ctx, supervisor, targetWs);
  }

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

// ---------------------------------------------------------------------------
// Compatibility gate (rappdw/sandy-ui#30). Runs once per activation, against
// the same cached schema resolution the settings panel uses (no extra sandy
// invocation beyond what's already needed). NON-BLOCKING by design: this
// only shows notifications and logs to the Sandy State channel — it never
// disables commands, never prevents activation, never blocks launch. A
// genuinely incompatible sandy surfaces its own errors when the user tries
// to actually use it, same as the --validate-config precedent.
// ---------------------------------------------------------------------------

async function runCompatCheck(ctx: vscode.ExtensionContext, out: vscode.OutputChannel): Promise<void> {
  // (batch-1 verify A2) getCachedSchema can't reject in practice — it always
  // resolves to a usable schema, falling back to the bundled mock on error —
  // but an activation-path floating rejection is a needless risk to leave on
  // the table. Log-only; never blocks activation.
  try {
    const res = await getCachedSchema(ctx.globalStorageUri.fsPath, schemaMock as Schema);
    const verdict = evaluateCompat(res.sandy_version, res.schema_version);

    out.appendLine(
      `[${new Date().toISOString()}] compat check: sandy=${res.sandy_version ?? "(not found)"} `
      + `schema=${res.schema_version ?? "?"} verdict=${verdict.kind} `
      + `(declared floor: sandy >= ${SANDY_MIN_VERSION}, schema in [${SUPPORTED_SCHEMA_VERSIONS.join(", ")}])`
    );

    if (verdict.kind === "too-old" || verdict.kind === "schema-unsupported-major") {
      vscode.window.showErrorMessage(`Sandy: ${describeVerdict(verdict).message}`);
    } else if (verdict.kind === "schema-too-new") {
      vscode.window.showWarningMessage(`Sandy: ${describeVerdict(verdict).message}`);
    }
    // "sandy-missing"/"ok" — nothing to surface here; a missing sandy already
    // gets its own fallback UX (tree placeholder, settings banner).

    // Loud mock-schema fallback (rappdw/sandy-ui#30): sandy IS present (we got
    // a version) but --print-schema itself failed, so settings render against
    // the bundled mock rather than this sandy's real schema — the settings
    // form can silently drift from what this sandy actually accepts. The
    // settings panel already shows a banner for this case (see
    // src/settings/webviewPanel.ts); this is the activation-time surface for
    // anyone who never opens Settings. Simpler one-time-warning path chosen
    // over threading a schemaSourceProvider into ProjectsTreeProvider for a
    // dedicated tree node — the settings banner remains the primary, detailed
    // surface either way.
    if (res.source === "fallback" && res.sandy_version) {
      vscode.window.showWarningMessage(
        `Sandy: sandy is installed but --print-schema failed — using the bundled mock schema. `
        + `Settings may not match your sandy version. See the "Sandy Settings" output channel for details.`
      );
    }
  } catch (e: any) {
    out.appendLine(`[${new Date().toISOString()}] compat check failed: ${e?.message ?? e}`);
  }
}

// ---------------------------------------------------------------------------
// Doctor checks (rappdw/sandy-ui#31): the fix-it steps of the "Sandy: Get
// Started" walkthrough complete via context keys, not polling inside the
// walkthrough UI itself — VSCode's walkthrough completionEvents watch
// `onContext:<key>`, so setting these two keys IS what ticks checkSandy/
// checkDocker off. Runs once at activation and again on every poller change
// (wired in activate()) so the steps go green live as the user fixes things,
// without requiring a reload.
// ---------------------------------------------------------------------------

let lastDoctorStatus: DoctorStatus | undefined;

async function runDoctorChecks(
  ctx: vscode.ExtensionContext,
  poller: StatePoller,
  out: vscode.OutputChannel,
): Promise<void> {
  try {
    // Same cached-schema resolution runCompatCheck uses — a cache hit is
    // cheap, so a second call here (rather than threading the result
    // through) keeps this function self-contained and callable from
    // poller.onDidChange independently of the activation-only compat check.
    const res = await getCachedSchema(ctx.globalStorageUri.fsPath, schemaMock as Schema);
    const dockerReachable = poller.current().state?.docker_reachable;
    const status = deriveDoctorStatus(res.sandy_version, dockerReachable);

    await vscode.commands.executeCommand("setContext", "sandy.doctor.sandyOk", status.sandyOk);
    await vscode.commands.executeCommand("setContext", "sandy.doctor.dockerOk", status.dockerOk);

    if (!lastDoctorStatus || lastDoctorStatus.sandyOk !== status.sandyOk || lastDoctorStatus.dockerOk !== status.dockerOk) {
      out.appendLine(
        `[${new Date().toISOString()}] doctor: sandyOk=${status.sandyOk} `
        + `(version=${status.sandyVersion ?? "(not found)"}) dockerOk=${status.dockerOk}`
      );
      lastDoctorStatus = status;
    }
  } catch (e: any) {
    out.appendLine(`[${new Date().toISOString()}] doctor check failed: ${e?.message ?? e}`);
  }
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

// ---------------------------------------------------------------------------
// Auto-restore on window open (rappdw/sandy-ui#32). Opt-in convenience: the
// reverse of detach-on-quit — if THIS workspace already has a persisted sandy
// daemon session running on the host (sandy >= 1.1.0, sandy.persistSessions
// on), reopen the Sandy tab attached to it automatically instead of making
// the user click. Defaults OFF and is a strict no-op when unset (step 1's
// gate returns before touching anything else — no poll, no command).
//
// FIRST-RUN GATE (rappdw/sandy-ui#31, landed): auto-restore now defers to
// first-run via the sandy.hasLaunched globalState marker, set once inside
// the sandy.launch command registration in activate(). A fresh profile that
// has never actually launched sandy never auto-restores, even if
// restoreSessionsOnStartup is somehow already on (e.g. via Settings Sync) —
// the walkthrough / an explicit first launch should come first, not a
// surprise session reopening on some later window open.
// ---------------------------------------------------------------------------

async function maybeRestoreSession(
  ctx: vscode.ExtensionContext,
  pendingAtActivation: PendingLaunch | undefined,
  poller: StatePoller,
  out: vscode.OutputChannel,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("sandy");
  const restoreEnabled = cfg.get<boolean>("restoreSessionsOnStartup", false);
  const persistEnabled = cfg.get<boolean>("persistSessions", true);
  if (!restoreEnabled || !persistEnabled) return;

  // First-run gate: never auto-restore for a profile that has never
  // launched sandy at least once (see FIRST-RUN GATE above).
  if (ctx.globalState.get<boolean>("sandy.hasLaunched") !== true) {
    out.appendLine(`[${new Date().toISOString()}] auto-restore: skipping — sandy.hasLaunched not yet set (first run)`);
    return;
  }

  // Never folder-pick on startup — that would be a surprising modal on every
  // window open. Nothing to restore against without a workspace anyway.
  const currentWs = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!currentWs) return;

  // No double-open, guard 1: a pending cross-window launch marker targeting
  // THIS workspace means resumePendingLaunchIfAny already owns firing
  // sandy.launch for it. Uses the pre-resume SNAPSHOT (resume has already
  // cleared the live marker synchronously by the time we run — reading
  // globalState here would always miss it; see the snapshot in activate()).
  if (pendingAtActivation && pendingAtActivation.workspace === currentWs
      && (Date.now() - pendingAtActivation.at) <= PENDING_LAUNCH_TTL_MS) {
    out.appendLine(`[${new Date().toISOString()}] auto-restore: skipping ${currentWs} — pending launch marker already owns it`);
    return;
  }

  // No double-open, guard 2: this extension host already has a live session
  // for the workspace. sandy.launch's own reveal guard would no-op anyway,
  // but skip early rather than round-tripping through it.
  if (supervisor?.getSession(currentWs)) return;

  // Best-effort bounded wait for --print-state to be ready: on cold
  // activation poller.current() may still be the t=0 empty state. One
  // refresh, and if that doesn't turn up a hit, one short re-check — not a
  // hard guarantee (docker can be slow to answer), so we don't retry
  // forever. If state still isn't ready, skip silently; the user can still
  // click.
  const checkOnce = (): boolean => {
    const state = poller.current().state;
    return !!persistedSessionForWorkspace(state?.running_containers ?? null, state?.sandboxes ?? [], currentWs);
  };

  await poller.refresh();
  let hit = checkOnce();
  if (!hit) {
    await new Promise<void>(resolve => setTimeout(resolve, 1_500));
    await poller.refresh();
    hit = checkOnce();
  }
  if (!hit) return;

  // Guard 2, re-checked AFTER the wait: resume's sandy.launch runs on a
  // 500ms timer and registers its session asynchronously, so a check before
  // the ~1.5s wait can miss it. Re-checking here closes the window where
  // resume's launch (or any other) landed a session while we waited.
  if (supervisor?.getSession(currentWs)) {
    out.appendLine(`[${new Date().toISOString()}] auto-restore: ${currentWs} acquired a session during the wait — skipping`);
    return;
  }

  // Single-window discipline: guards 1+2 above (plus sandy.launch's own
  // reveal guard) cover intra-instance dupes. Two VSCode windows open on the
  // SAME workspace both auto-restoring is the one real risk left, but that's
  // the same last-attach-wins territory daemon mode already defines (a
  // second attach displaces the first cleanly) — deliberately not adding
  // cross-window locking for an already-unusual scenario.
  out.appendLine(`[${new Date().toISOString()}] auto-restored persisted session for ${currentWs}`);
  await vscode.commands.executeCommand("sandy.launch", { workspacePath: currentWs });
}
