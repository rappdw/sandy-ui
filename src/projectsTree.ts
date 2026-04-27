import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import { StatePoller, StateResolution } from "./state/poller";
import { deriveBadge, SandboxBadge } from "./state/badge";
import type { SandySandbox } from "./state/types";

// Tree provider backed by `sandy --print-state` polling. Each top-level
// item is a sandbox; clicking a sandbox launches sandy against its
// workspace_path.
//
// When sandy is unreachable (not on PATH or --print-state errors), the tree
// falls back to a single "current workspace" placeholder so the launch
// command still works.

export class ProjectsTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly poller: StatePoller) {
    this.subscription = poller.onDidChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  refresh(): void { this._onDidChangeTreeData.fire(undefined); }

  getTreeItem(node: TreeNode): vscode.TreeItem { return node; }

  getChildren(): TreeNode[] {
    const r = this.poller.current();
    return buildNodes(r);
  }
}

type TreeNode = SandboxNode | StatusNode | EmptyNode;

function buildNodes(r: StateResolution): TreeNode[] {
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

  const sandboxes = state.sandboxes ?? [];
  if (sandboxes.length === 0) {
    nodes.push(new EmptyNode("No sandy sandboxes yet"));
  } else {
    for (const s of sandboxes) {
      const badge = deriveBadge(s, state.running_containers);
      nodes.push(new SandboxNode(s, badge));
    }
  }
  return nodes;
}

class SandboxNode extends vscode.TreeItem {
  constructor(public readonly sandbox: SandySandbox, public readonly badge: SandboxBadge) {
    super(abbreviatePath(sandbox.workspace_path), vscode.TreeItemCollapsibleState.None);
    this.iconPath = iconForBadge(badge);
    this.description = describe(sandbox, badge);
    this.tooltip = tooltipFor(sandbox, badge);
    this.contextValue = `sandbox.${badge}`;
    this.command = {
      command: "sandy.launch",
      title: "Launch",
      arguments: [{ workspacePath: sandbox.workspace_path }],
    };
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
  constructor(label: string, kind: "warning" | "loading", tooltip: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(kind === "warning" ? "warning" : "loading~spin");
    this.tooltip = tooltip;
    this.contextValue = `status.${kind}`;
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

function abbreviatePath(p: string): string {
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

function describe(s: SandySandbox, badge: SandboxBadge): string {
  const parts: string[] = [];
  if (s.agent) parts.push(s.agent);
  parts.push(badge);
  return parts.join(" · ");
}

function tooltipFor(s: SandySandbox, badge: SandboxBadge): string {
  const lines = [
    `Workspace: ${s.workspace_path}`,
    `Sandbox:   ${s.name}`,
    `State:     ${badge}` + (s.lock_held ? ` (lock pid ${s.lock_holder_pid ?? "?"})` : ""),
  ];
  if (s.agent)              lines.push(`Agent:     ${s.agent}`);
  if (s.last_used_at)       lines.push(`Last used: ${s.last_used_at}`);
  if (s.created_version)    lines.push(`Created with sandy ${s.created_version}`);
  if (s.compat_warning)     lines.push(`⚠ ${s.compat_warning}`);
  return lines.join("\n");
}
