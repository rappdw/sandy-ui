// Right-click context-menu integration for synthkit's md2{email,doc,pdf} CLIs.
//
// Lives under src/synthkit/ as a deliberately bounded module — sandy-ui's core
// purpose is wrapping the sandy CLI; synthkit is unrelated. If this grows, it
// should extract to a separate VSCode extension. Until then, isolating it
// here makes that future extraction a directory move.
//
// Tool behavior summary:
//   md2email — converts to clipboard-ready HTML, copies to clipboard (no file)
//   md2doc   — produces <name>.docx alongside the source
//   md2pdf   — produces <name>.pdf  alongside the source
//
// Binary resolution mirrors sandyPath's strategy (PATH + common install dirs)
// because dock-launched VSCode on macOS has a narrow PATH that misses
// /usr/local/bin where pip/pipx puts CLI shims.

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export type SynthkitTool = "md2email" | "md2doc" | "md2pdf";

const COMMON_INSTALL_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  path.join(os.homedir(), ".local/bin"),
  path.join(os.homedir(), "bin"),
  "/usr/bin",
];

const binaryCache = new Map<SynthkitTool, string>();

function resolveBinary(tool: SynthkitTool): string | undefined {
  const cached = binaryCache.get(tool);
  if (cached) return cached;
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...COMMON_INSTALL_DIRS]) {
    const candidate = path.join(dir, tool);
    try { fs.accessSync(candidate, fs.constants.X_OK); binaryCache.set(tool, candidate); return candidate; }
    catch { /* not here */ }
  }
  return undefined;
}

// Resolve the target file URI from whatever VSCode passed. explorer/context
// and editor/title/context pass a Uri; editor/context and palette pass
// nothing (fall back to active editor). Multi-selection from explorer also
// passes a Uri[] as second arg, but for now we treat invocations as
// single-file — md2{doc,pdf} support multi-args, but the UX of a single
// notification per file scales better with explicit per-file invocation.
function resolveTargetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) return arg;
  return vscode.window.activeTextEditor?.document.uri;
}

export async function runSynthkitCommand(
  tool: SynthkitTool,
  arg: unknown,
  out: vscode.OutputChannel,
): Promise<void> {
  const uri = resolveTargetUri(arg);
  if (!uri || uri.scheme !== "file") {
    void vscode.window.showWarningMessage(`Synthkit: ${tool} needs a local .md file.`);
    return;
  }
  const filePath = uri.fsPath;
  if (!filePath.toLowerCase().endsWith(".md")) {
    void vscode.window.showWarningMessage(`Synthkit: ${tool} expects a .md file (got ${path.basename(filePath)}).`);
    return;
  }

  const bin = resolveBinary(tool);
  if (!bin) {
    void vscode.window.showErrorMessage(
      `Synthkit: '${tool}' not found on PATH or in common install locations. ` +
      `Install via 'pip install synthkit' (or pipx) and reload VSCode.`
    );
    return;
  }

  const t0 = Date.now();
  out.appendLine(`[${new Date().toISOString()}] ${tool} ${filePath}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Synthkit: ${tool}`, cancellable: false },
    () => new Promise<void>((resolve) => {
      const child = cp.spawn(bin, [filePath], {
        cwd: path.dirname(filePath),
        env: process.env,
      });
      let stderr = "";
      child.stdout.on("data", b => out.append(String(b)));
      child.stderr.on("data", b => { const s = String(b); stderr += s; out.append(s); });
      child.on("error", (err) => {
        out.appendLine(`[${tool}] spawn error: ${err.message}`);
        void vscode.window.showErrorMessage(`Synthkit: ${tool} failed to start — ${err.message}`);
        resolve();
      });
      child.on("close", (code) => {
        const dur = Date.now() - t0;
        out.appendLine(`[${tool}] exit ${code} (${dur}ms)`);
        if (code === 0) {
          handleSuccess(tool, filePath, out);
        } else {
          const tail = stderr.trim().split("\n").slice(-3).join(" / ") || `exit code ${code}`;
          void vscode.window.showErrorMessage(`Synthkit: ${tool} failed — ${tail}`);
        }
        resolve();
      });
    })
  );
}

function handleSuccess(tool: SynthkitTool, sourcePath: string, out: vscode.OutputChannel): void {
  if (tool === "md2email") {
    void vscode.window.showInformationMessage("Synthkit: email HTML copied to clipboard.");
    return;
  }
  // md2doc → .docx, md2pdf → .pdf, output landed alongside the source
  const ext = tool === "md2doc" ? ".docx" : ".pdf";
  const outPath = sourcePath.replace(/\.md$/i, ext);
  if (!fs.existsSync(outPath)) {
    out.appendLine(`[${tool}] expected output not found at ${outPath}`);
    void vscode.window.showWarningMessage(`Synthkit: ${tool} reported success but ${path.basename(outPath)} wasn't found alongside the source.`);
    return;
  }
  void vscode.window
    .showInformationMessage(`Synthkit: ${path.basename(outPath)} created.`, "Reveal", "Open")
    .then(action => {
      if (action === "Reveal") void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(outPath));
      else if (action === "Open") void vscode.env.openExternal(vscode.Uri.file(outPath));
    });
}
