import * as vscode from "vscode";

// Single hardcoded project for the spike — proves the activity-bar contribution
// renders, with a Launch action wired to the same command as the palette.
export class ProjectsTreeProvider implements vscode.TreeDataProvider<ProjectItem> {
  getTreeItem(e: ProjectItem) { return e; }
  getChildren(): ProjectItem[] {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(no workspace)";
    return [new ProjectItem(ws)];
  }
}

class ProjectItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("terminal");
    this.command = { command: "sandy.launch", title: "Launch", arguments: [] };
    this.tooltip = "Launch sandy in this workspace (spike)";
  }
}
