import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { StatePoller, StateResolution } from "./state/poller";
import { deriveBadge, daemonInfoFor, formatAge, SandboxBadge, DaemonInfo } from "./state/badge";
import type { SandySandbox, SandyRunningContainer } from "./state/types";
import type { PtySupervisor } from "./terminal/supervisor";

// Tree provider backed by `sandy --print-state` polling AND the
// PtySupervisor's view of which workspaces have a live PTY. Supervisor's
// view outranks sandy's running_containers report — if WE spawned a sandy
// and have a session for it, the badge shows "running" immediately, even
// if sandy --print-state hasn't caught up (or is buggy and the container
// info doesn't match the sandbox name).
//
// When sandy is unreachable (not on PATH or --print-state errors), the
// tree falls back to a single "current workspace" placeholder so the
// launch command still works.

export class ProjectsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly poller: StatePoller,
    private readonly supervisor: PtySupervisor,
  ) {
    this.subscriptions.push(
      poller.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
      supervisor.onDidChange(() => this._onDidChangeTreeData.fire(undefined)),
    );
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(node: TreeNode): vscode.TreeItem { return node; }

  getChildren(): TreeNode[] {
    const r = this.poller.current();
    const supervisorWorkspaces = new Set(
      this.supervisor.getAllSessions().map(s => s.workspacePath),
    );
    return buildNodes(r, supervisorWorkspaces);
  }
}

type TreeNode = SandboxNode | StatusNode | EmptyNode;

function buildNodes(r: StateResolution, supervisorWorkspaces: ReadonlySet<string>): TreeNode[] {
  // Initial state (poll hasn't returned yet): show a loading placeholder.
  if (!r.state && !r.error && r.fetched_at.getTime() === 0) {
    return [new StatusNode("Loading…", "loading", "Polling sandy --print-state")];
  }

  // Fallback when sandy isn't available: still let the user launch in the
  // current workspace via the existing folder-picker flow.
  if (r.error || !r.state) {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const nodes: TreeNode[] = [
      new StatusNode("⚠ sandy unavailable", "warning",
        r.error ? `${r.error} — tree shows current workspace only` : "no state yet"),
    ];
    if (ws) nodes.push(SandboxNode.forBareWorkspace(ws));
    return nodes;
  }

  const state = r.state;
  const nodes: TreeNode[] = [];

  if (state.docker_reachable === false) {
    nodes.push(new StatusNode(
      "⚠ Docker unreachable",
      "warning",
      "running_containers data unavailable; sandbox state is from disk only",
    ));
  }

  if (typeof state.orphan_networks === "number" && state.orphan_networks > 0) {
    const n = state.orphan_networks;
    nodes.push(new StatusNode(
      `⚠ ${n} orphaned sandy network${n === 1 ? "" : "s"}`,
      "warning",
      "Left behind by crashed/killed sessions. Click to run sandy --prune-orphans.",
      { command: "sandy.pruneOrphans", title: "Prune Orphaned Networks" },
    ));
  }

  const sandboxes = state.sandboxes ?? [];
  if (sandboxes.length === 0) {
    nodes.push(new EmptyNode("No sandy sandboxes yet"));
  } else {
    for (const s of sandboxes) {
      try {
        const badge = deriveBadge(s, state.running_containers, { supervisorRunningWorkspaces: supervisorWorkspaces });
        nodes.push(new SandboxNode(s, badge, state.running_containers));
      } catch (e: any) {
        // One malformed sandbox entry shouldn't break the entire tree.
        nodes.push(new StatusNode(`⚠ skipped ${s?.name ?? "(unnamed)"}`, "warning",
          `Failed to render sandbox: ${e?.message ?? e}`));
      }
    }
  }
  return nodes;
}

class SandboxNode extends vscode.TreeItem {
  constructor(
    public readonly sandbox: SandySandbox,
    public readonly badge: SandboxBadge,
    runningContainers: SandyRunningContainer[] | null = null,
  ) {
    // Sandy MAY omit workspace_path on orphan/legacy sandboxes — fall back to
    // sandbox.path or sandbox.name so the tree can still render. Don't crash
    // on a single malformed entry.
    const labelSource = sandbox.workspace_path || sandbox.path || sandbox.name || "(unknown sandbox)";
    super(abbreviatePath(labelSource), vscode.TreeItemCollapsibleState.None);
    const daemonInfo = daemonInfoFor(sandbox.name, runningContainers);
    this.iconPath = iconForBadge(badge);
    this.description = describe(sandbox, badge, daemonInfo);
    this.tooltip = tooltipFor(sandbox, badge, daemonInfo);
    this.contextValue = `sandbox.${badge}`;
    // Only attach the launch command when we have an actual workspace path —
    // launching against a missing/null path would just open the folder picker.
    if (sandbox.workspace_path) {
      this.command = {
        command: "sandy.launch",
        title: "Launch",
        arguments: [{ workspacePath: sandbox.workspace_path }],
      };
    }
  }

  // Construct a placeholder node from just a workspace path (used when sandy
  // is unavailable but VSCode has a workspace folder open).
  static forBareWorkspace(workspacePath: string): SandboxNode {
    const fake: SandySandbox = { name: path.basename(workspacePath), path: "", workspace_path: workspacePath };
    const node = new SandboxNode(fake, "current");
    node.tooltip = `${workspacePath} (sandy not reporting state)`;
    node.description = "(no sandbox metadata)";
    return node;
  }
}

class StatusNode extends vscode.TreeItem {
  constructor(label: string, kind: "warning" | "loading", tooltip: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(kind === "warning" ? "warning" : "loading~spin");
    this.tooltip = tooltip;
    this.contextValue = `status.${kind}`;
    if (command) this.command = command;
  }
}

class EmptyNode extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("circle-outline");
    this.contextValue = "empty";
  }
}

// --- presentation helpers --------------------------------------------------

function abbreviatePath(p: string | undefined | null): string {
  if (!p) return "(no path)";
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function iconForBadge(badge: SandboxBadge): vscode.ThemeIcon {
  switch (badge) {
    case "running": return new vscode.ThemeIcon("debug-start", new vscode.ThemeColor("debugIcon.startForeground"));
    case "locked":  return new vscode.ThemeIcon("lock",        new vscode.ThemeColor("editorWarning.foreground"));
    case "stale":   return new vscode.ThemeIcon("clock",       new vscode.ThemeColor("descriptionForeground"));
    case "fresh":   return new vscode.ThemeIcon("sparkle");
    case "current": return new vscode.ThemeIcon("terminal");
  }
}

function describe(s: SandySandbox, badge: SandboxBadge, daemonInfo?: DaemonInfo): string {
  const parts: string[] = [];
  if (s.agent) parts.push(s.agent);
  parts.push(badge);
  const base = parts.join(" · ");
  if (!daemonInfo) return base;
  const clients = daemonInfo.attachedClients != null
    ? ` (${daemonInfo.attachedClients} client${daemonInfo.attachedClients === 1 ? "" : "s"})`
    : "";
  const age = daemonInfo.startedAt ? formatAge(daemonInfo.startedAt) : undefined;
  const upSuffix = age ? ` · up ${age}` : "";
  return `${base} · persisted${clients}${upSuffix}`;
}

function tooltipFor(s: SandySandbox, badge: SandboxBadge, daemonInfo?: DaemonInfo): string {
  const lines = [
    `Workspace: ${s.workspace_path ?? "(unknown — sandbox has no workspace_path)"}`,
    `Sandbox:   ${s.name}`,
    `State:     ${badge}` + (s.lock_held ? ` (lock pid ${s.lock_holder_pid ?? "?"})` : ""),
  ];
  if (s.agent)              lines.push(`Agent:     ${s.agent}`);
  if (s.last_used_at)       lines.push(`Last used: ${s.last_used_at}`);
  if (s.created_version)    lines.push(`Created with sandy ${s.created_version}`);
  if (s.compat_warning)     lines.push(`⚠ ${s.compat_warning}`);
  if (daemonInfo) {
    lines.push(`Daemon:    persisted session — survives VSCode restarts`);
    if (daemonInfo.attachedClients != null) lines.push(`Clients:   ${daemonInfo.attachedClients} attached`);
    if (daemonInfo.startedAt) {
      const age = formatAge(daemonInfo.startedAt);
      if (age) lines.push(`Up:        ${age} (since ${daemonInfo.startedAt})`);
    }
  }
  return lines.join("\n");
}
