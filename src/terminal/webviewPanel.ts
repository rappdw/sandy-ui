import * as vscode from "vscode";
import { launchCandidates, buildCleanEnv } from "./pty";
import { OscEvent } from "./oscHandler";
import { sweepStaleLocks } from "./sandyState";
import { checkPreflightApproval } from "../approval/preflight";
import { PtySupervisor, Session } from "./supervisor";

const out = vscode.window.createOutputChannel("Sandy");
const log = (msg: string) => out.appendLine(`[${new Date().toISOString()}] ${msg}`);

// Messages between the webview (xterm.js) and the extension host (PTY owner).
type ToHost =
  | { type: "ready"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "osc";    event: OscEvent }
  | { type: "log";    level: "info" | "error"; msg: string };

type FromHost =
  | { type: "init"; cols: number; rows: number }
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "refit" };

export async function openTerminalPanel(
  ctx: vscode.ExtensionContext,
  supervisor: PtySupervisor,
  workspaceOverride?: string,
) {
  // Source-of-workspace priority:
  //   1. Explicit override (from tree-item click — sandy.launch invoked with
  //      { workspacePath } argument)
  //   2. Current VSCode workspace folder
  //   3. User's folder picker (don't silently fall back to $HOME — sandy
  //      scans the workspace, would TCC-cascade on macOS)
  let ws = workspaceOverride ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      title: "Pick a workspace folder for sandy",
      openLabel: "Use as workspace",
    });
    if (!picked || picked.length === 0) {
      vscode.window.showWarningMessage("Sandy: no workspace selected — launch cancelled. (Sandy scans the workspace; defaulting to ~/ would touch every protected dir on macOS.)");
      return;
    }
    ws = picked[0].fsPath;
  }

  // If a session already exists for this workspace, this is a re-attach —
  // skip preflight (already done at original spawn) and reuse the live PTY.
  const existingSession = supervisor.getSession(ws);
  const isReattach = existingSession !== undefined;

  let approveEnv: Record<string, string> = {};
  if (!isReattach) {
    // Pre-flight approval check. Runs `sandy --validate-config` and shows
    // the approval modal if the workspace config has privileged keys
    // requiring explicit approval. Errors from validate are non-fatal —
    // we proceed and let sandy itself enforce approval at launch time.
    const preflight = await checkPreflightApproval(ctx, ws);
    if (preflight.error) log(`preflight: ${preflight.error} (proceeding; sandy will enforce)`);
    if (preflight.validation?.approval_status) log(`preflight: approval_status=${preflight.validation.approval_status}`);
    if (!preflight.proceed) {
      log("preflight: user rejected — launch cancelled");
      return;
    }
    approveEnv = preflight.setApproveEnv ? { SANDY_AUTO_APPROVE_PRIVILEGED: "1" } : {};
    if (preflight.setApproveEnv) log("preflight: SANDY_AUTO_APPROVE_PRIVILEGED=1 set for THIS launch only");
  } else {
    log(`re-attaching to existing session for workspace=${ws}`);
  }

  // Maximize editor space for the sandy session if the user has opted in
  // (defaults: bottom panel + auxiliary bar closed; primary sidebar kept).
  // Each command is fire-and-forget — we don't await, don't fail launch
  // if any errors. void executeCommand returns are intentional.
  await maximizeEditorSpaceIfRequested();

  const panel = vscode.window.createWebviewPanel(
    "sandy.terminal",
    "Sandy",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,  // keep xterm buffer alive across hide/show
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    }
  );

  const mediaUri = (sub: string) =>
    panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "terminal", sub));
  panel.webview.html = renderHtml({
    cspSource: panel.webview.cspSource,
    xtermJs:    mediaUri("vendor/xterm.js"),
    xtermCss:   mediaUri("vendor/xterm.css"),
    fitAddon:   mediaUri("vendor/addon-fit.js"),
    linksAddon: mediaUri("vendor/addon-web-links.js"),
    bridgeJs:   mediaUri("dist/bridge.js"),
    css:        mediaUri("terminal.css"),
  });

  // The session this panel will be bound to. Either we re-attach to an
  // existing live PTY, or we spawn a new one inside the "ready" handler
  // once we know the webview's measured cols/rows.
  let session: Session | undefined;

  log(`openTerminalPanel: workspace=${ws}${isReattach ? " (re-attach)" : ""}`);

  const sub = panel.webview.onDidReceiveMessage((m: ToHost) => {
    switch (m.type) {
      case "ready": {
        log(`webview ready (initial size ${m.cols}x${m.rows})`);

        if (isReattach && existingSession) {
          // Re-attach: skip lock sweep, skip spawn. Bind the panel to the
          // existing PTY and force a tmux repaint so the user sees the
          // current screen state. tmux only emits diffs from what it
          // thinks the terminal is showing — the fresh xterm.js has no
          // history, so we need to provoke a full redraw. Resize-toggle
          // (rows → rows-1 → rows) triggers SIGWINCH which tmux always
          // responds to with a full screen redraw. Two short delays so
          // the resizes register as distinct events.
          session = existingSession;
          supervisor.attach(ws!, panel);
          panel.title = `Sandy (re-attached pid=${session.pty.pid})`;
          panel.webview.postMessage(<FromHost>{
            type: "data",
            data: `\r\n\x1b[2m[re-attached to existing sandy pid=${session.pty.pid}]\x1b[0m\r\n`,
          });
          const cols = m.cols || 80;
          const rows = m.rows || 24;
          try {
            const sess = session;
            sess.pty.resize(cols, rows);
            setTimeout(() => {
              try { sess.pty.resize(cols, Math.max(rows - 1, 2)); } catch { /* swallow */ }
              setTimeout(() => {
                try { sess.pty.resize(cols, rows); } catch { /* swallow */ }
              }, 60);
            }, 80);
          } catch (e: any) { log(`re-attach resize failed: ${e?.message ?? e}`); }
          break;
        }

        // Fresh spawn path. Stale-lock sweep first — VSCode reload / crash
        // interrupts sandy's cleanup trap and leaves locks behind that
        // block re-launch.
        try {
          const sweep = sweepStaleLocks(ws);
          if (sweep.cleaned.length) log(`cleaned ${sweep.cleaned.length} stale lock(s): ${sweep.cleaned.join(", ")}`);
          if (sweep.alive.length)   log(`live lock(s) — sandy will refuse to launch: ${sweep.alive.join(", ")}`);
          if (sweep.unknown.length) log(`unparseable lock(s) left alone: ${sweep.unknown.join(", ")}`);
        } catch (e: any) {
          log(`lock sweep failed (continuing): ${e?.message ?? e}`);
        }

        const env = buildCleanEnv(approveEnv);
        log(`PATH: ${env.PATH}`);

        // Allow explicit override via workspace setting.
        const override = vscode.workspace.getConfiguration("sandy").get<string>("launchCommand", "").trim();
        const candidates = override
          ? [{ command: override.split(/\s+/)[0], args: override.split(/\s+/).slice(1) }]
          : launchCandidates();
        log(`candidates: ${candidates.map(c => `${c.command} ${c.args.join(" ")}`.trim()).join("  |  ")}`);

        const errors: string[] = [];
        for (const c of candidates) {
          try {
            log(`trying: ${c.command} ${c.args.join(" ")}`);
            session = supervisor.spawn({
              workspacePath: ws,
              command: c.command, args: c.args,
              cwd: ws, env,
              cols: m.cols || 80, rows: m.rows || 24,
            });
            log(`spawned: ${c.command} pid=${session.pty.pid}`);
            panel.title = `Sandy (${c.command.split("/").pop()} ${c.args.join(" ")})`.trim();
            break;
          } catch (e: any) {
            const msg = `${c.command}: ${e?.message ?? e}`;
            errors.push(msg);
            log(`spawn failed for ${msg}`);
          }
        }
        if (!session) {
          const msg = `All launch candidates failed:\n  ${errors.join("\n  ")}`;
          vscode.window.showErrorMessage(`Sandy: ${errors[errors.length - 1] ?? "no command worked"}`);
          panel.webview.postMessage(<FromHost>{ type: "data", data: `\r\n\x1b[31m[host] ${msg}\x1b[0m\r\n` });
          return;
        }
        supervisor.attach(ws, panel);
        // Title flip on exit (data flow + exit posting handled by supervisor).
        session.pty.onExit((code) => {
          panel.title = `Sandy (exit ${code})`;
        });
        break;
      }
      case "input":  session?.pty.write(m.data); break;
      case "resize": log(`resize ${m.cols}x${m.rows}`); session?.pty.resize(m.cols, m.rows); break;
      case "osc":    handleOsc(panel, m.event); break;
      case "log":    log(`[webview ${m.level}] ${m.msg}`); break;
    }
  });

  // Surface the output channel proactively so the user sees what's happening
  // — but ONLY if they haven't asked to keep the bottom panel closed (which
  // is where the output channel lives). Showing it would re-open the panel
  // we just closed for them.
  if (!vscode.workspace.getConfiguration("sandy.launch").get<boolean>("closeBottomPanel", true)) {
    out.show(true);
  }

  // On tab close: distinguish detach (user invoked sandy.tree.detach which
  // cleared session.panel before disposing) from a normal close (user
  // wants the session stopped). Supervisor's signal escalation handles
  // the actual stop; we only call supervisor.stop() if the session is
  // still attached when the panel disposes.
  panel.onDidDispose(async () => {
    sub.dispose();
    if (!session) return;
    // If supervisor's session.panel === undefined OR points elsewhere,
    // this dispose is from a detach (already handled) or from a stale
    // close (another panel took over) — don't kill.
    if (session.panel !== panel) {
      log(`tab disposed but session is detached/reassigned for ${ws} — leaving PTY alive`);
      return;
    }
    log(`tab closed, stopping session for workspace=${ws}`);
    await supervisor.stop(ws);
  });

  // When the user switches away from the Sandy tab and back, the iframe
  // briefly drops to zero width and xterm.js settles to a squished few-cols
  // state. ResizeObserver doesn't re-fire on the way back (DOM size matches
  // the squished value), so we explicitly tell the webview to refit on
  // visibility-restore. Bridge handles "refit" with two rAFs to let VSCode's
  // layout settle before measuring.
  panel.onDidChangeViewState(e => {
    if (e.webviewPanel.visible) {
      panel.webview.postMessage({ type: "refit" });
    }
  });
}

// Reads sandy.launch.close{BottomPanel,AuxiliaryBar,Sidebar} settings and
// fires VSCode's built-in close commands for whichever are enabled. All
// errors are swallowed — this is best-effort UX, never blocks the launch.
async function maximizeEditorSpaceIfRequested(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("sandy.launch");
  const closeBottom = cfg.get<boolean>("closeBottomPanel",  true);
  const closeAux    = cfg.get<boolean>("closeAuxiliaryBar", true);
  const closeSide   = cfg.get<boolean>("closeSidebar",      false);

  const tryRun = async (cmd: string): Promise<void> => {
    try { await vscode.commands.executeCommand(cmd); }
    catch { /* command may not exist on older VSCode; non-fatal */ }
  };

  if (closeBottom) await tryRun("workbench.action.closePanel");
  if (closeAux)    await tryRun("workbench.action.closeAuxiliaryBar");
  if (closeSide)   await tryRun("workbench.action.closeSidebar");
}

function handleOsc(panel: vscode.WebviewPanel, ev: OscEvent) {
  switch (ev.kind) {
    case "notification": {
      const msg = ev.body ? `${ev.title} — ${ev.body}` : ev.title;
      vscode.window.showInformationMessage(`[OSC ${ev.code}] ${msg}`);
      // Tab badge — VSCode's webview API doesn't expose dot badges directly,
      // but title prefix is the common workaround.
      if (!panel.title.startsWith("● ")) panel.title = "● " + panel.title;
      break;
    }
    case "clipboard": {
      vscode.env.clipboard.writeText(ev.data).then(() =>
        vscode.window.setStatusBarMessage(`Sandy: copied ${ev.data.length} bytes via OSC 52`, 3000)
      );
      break;
    }
    case "title": {
      panel.title = ev.title;
      break;
    }
    case "hyperlink": {
      // No-op for spike — xterm-addon-web-links handles plain http(s) links.
      break;
    }
  }
}

function renderHtml(uris: {
  cspSource: string;
  xtermJs:    vscode.Uri;
  xtermCss:   vscode.Uri;
  fitAddon:   vscode.Uri;
  linksAddon: vscode.Uri;
  bridgeJs:   vscode.Uri;
  css:        vscode.Uri;
}): string {
  const csp = `default-src 'none'; script-src ${uris.cspSource}; style-src ${uris.cspSource} 'unsafe-inline'; font-src ${uris.cspSource};`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${uris.xtermCss}" />
  <link rel="stylesheet" href="${uris.css}" />
</head>
<body>
  <div id="terminal"></div>
  <script src="${uris.xtermJs}"></script>
  <script src="${uris.fitAddon}"></script>
  <script src="${uris.linksAddon}"></script>
  <script src="${uris.bridgeJs}"></script>
</body>
</html>`;
}

