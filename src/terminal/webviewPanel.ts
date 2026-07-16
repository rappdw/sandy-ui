import * as vscode from "vscode";
import { launchCandidates, buildCleanEnv, spawnPty } from "./pty";
import { OscEvent } from "./oscHandler";
import { sweepStaleLocks, readLockPid, isPidAlive } from "./sandyState";
import * as fs from "fs";
import { checkPreflightApproval } from "../approval/preflight";
import { PtySupervisor, Session } from "./supervisor";
// Daemon-mode eligibility (sandy-ui#12 batch 2): same schema-cache pattern
// settings/webviewPanel.ts uses to source the mock fallback.
import schemaMock from "../mocks/schema.json";
import { getCachedSchema } from "../schema/cache";
import { hasDaemonCapability, startArgs, attachArgs } from "../daemon/contract";
import { resolveSandyBinary } from "../state/sandyPath";
import { Schema } from "../settings/configIO";

const out = vscode.window.createOutputChannel("Sandy");
const log = (msg: string) => out.appendLine(`[${new Date().toISOString()}] ${msg}`);

// Messages between the webview (xterm.js) and the extension host (PTY owner).
type ToHost =
  | { type: "ready"; cols: number; rows: number }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "osc";    event: OscEvent }
  | { type: "openExternal"; uri: string }
  | { type: "log";    level: "info" | "error"; msg: string };

type FromHost =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "refit" }
  | { type: "scrollSensitivity"; value: number };

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

  // Already attached to a live panel? Reveal that panel instead of creating
  // a second one — a duplicate would silently steal the PTY stream and leave
  // the first tab frozen (review finding B6).
  if (existingSession?.panel) {
    existingSession.panel.reveal(existingSession.panel.viewColumn ?? vscode.ViewColumn.Active, false);
    return;
  }

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

  // Daemon eligibility (sandy-ui#12 batch 2), computed once per call, up
  // front alongside preflight since the capability check is async but
  // cheap (cache-hit path). `sandy.persistSessions` gates it off entirely
  // (legacy lifecycle); a missing/unresolvable sandy binary also falls
  // back to legacy — there's nothing to run --start/--attach with.
  // `sandy.launchCommand` (read ONCE, here) is a harder override: an
  // explicit launch command forces the legacy lifecycle unconditionally —
  // short-circuit FIRST so an overridden launch doesn't even shell out to
  // the schema cache to check daemon capability (sandy-ui#24).
  const launchOverride = vscode.workspace.getConfiguration("sandy").get<string>("launchCommand", "").trim();
  const persist = vscode.workspace.getConfiguration("sandy").get<boolean>("persistSessions", true);
  const daemonCapable = !launchOverride && persist && hasDaemonCapability((await getCachedSchema(ctx.globalStorageUri.fsPath, schemaMock as Schema)).schema);
  const sandyBin = daemonCapable ? resolveSandyBinary() : undefined;
  const useDaemon = !launchOverride && daemonCapable && !!sandyBin;   // no resolvable binary → legacy path
  log(`launch mode: ${useDaemon ? "daemon" : "legacy"} (persistSessions=${persist}, daemonCapable=${daemonCapable}, sandyBin=${sandyBin ?? "n/a"}, launchOverride=${launchOverride || "none"})`);
  if (launchOverride) log("launchCommand override set — legacy lifecycle");

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

  // Latest requested terminal dimensions, tracked at panel scope so the
  // daemon path's phase-2 attach spawn (after `sandy --start` exits, which
  // can be long — image build / seeding) sizes its pty to whatever the
  // user has resized to since "ready", not a stale ready-time snapshot.
  // Initialized from "ready", updated by the "resize" case below (only for
  // resizes that pass the existing suppression checks).
  let lastCols = 80;
  let lastRows = 24;

  // Push the wheel-scroll sensitivity to the webview, now and whenever the
  // setting changes — so users can tune scroll speed live without reloading.
  const pushScrollSensitivity = () => {
    const value = vscode.workspace
      .getConfiguration("sandy.terminal")
      .get<number>("scrollSensitivity", 2);  // fallback matches package.json default
    panel.webview.postMessage(<FromHost>{ type: "scrollSensitivity", value });
  };
  pushScrollSensitivity();
  const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("sandy.terminal.scrollSensitivity")) pushScrollSensitivity();
  });

  log(`openTerminalPanel: workspace=${ws}${isReattach ? " (re-attach)" : ""}`);

  const sub = panel.webview.onDidReceiveMessage(async (m: ToHost) => {
    switch (m.type) {
      case "ready": {
        log(`webview ready (initial size ${m.cols}x${m.rows})`);
        pushScrollSensitivity(); // guaranteed-delivered now the listener is up

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

        // isReattach only fires when the supervisor already holds a live
        // session for this workspace with panel === undefined — i.e. an
        // in-window detach (B6's reveal-existing-panel guard upstream
        // handles the "still attached" case by revealing instead of
        // getting here at all). A daemon session's in-window detach
        // removes it from the supervisor's map entirely (see
        // PtySupervisor.detach's daemon branch), so a re-launch after
        // detaching a daemon session never hits isReattach — it falls
        // through to the useDaemon branch below, where `--start` no-ops
        // (exit 0, instant, idempotent per the frozen contract) and goes
        // straight to a fresh attach. Direct-backend in-window detach is
        // the only path that still lands in isReattach above. Uniform
        // either way from the user's perspective.

        if (useDaemon) {
          // Daemon fresh-spawn path (sandy-ui#12 batch 2). Stale-lock
          // sweep still runs (dead-PID cleanup is still wanted), but the
          // orphan-lock modal is a legacy-only concept: under daemon mode
          // a live lock is the EXPECTED state (the daemon holds it across
          // VSCode sessions), and a genuine bare-CLI conflict makes
          // `--start` itself fail with an informative error that streams
          // live into the visible terminal — no need to pre-empt it with
          // a modal. We just log live locks instead of prompting.
          try {
            const sweep = sweepStaleLocks(ws);
            if (sweep.cleaned.length) log(`cleaned ${sweep.cleaned.length} stale lock(s): ${sweep.cleaned.join(", ")}`);
            if (sweep.alive.length)   log(`live lock(s) detected (daemon mode — expected, no prompt): ${sweep.alive.join(", ")}`);
            if (sweep.unknown.length) log(`unparseable lock(s) left alone: ${sweep.unknown.join(", ")}`);
          } catch (e: any) {
            log(`lock sweep failed (continuing): ${e?.message ?? e}`);
          }

          const env = buildCleanEnv(approveEnv);
          log(`PATH: ${env.PATH}`);
          lastCols = m.cols || 80;
          lastRows = m.rows || 24;

          log(`daemon: sandy --start workspace=${ws}`);
          const startPty = spawnPty({
            command: sandyBin!, args: startArgs(ws),
            cwd: ws, env,
            cols: lastCols, rows: lastRows,
          });
          session = supervisor.beginDaemon(ws, startPty);
          supervisor.attach(ws, panel);
          panel.title = "Sandy (starting…)";

          // Policy for what --start's exit means lives HERE, not in the
          // supervisor: beginDaemon() deliberately leaves it to the
          // caller (see its doc comment).
          startPty.onExit((code) => {
            if (code === 0) {
              // Tab closed (or explicitly detached) while --start ran:
              // supervisor.detach() removed the daemon session from the map
              // synchronously, so getSession() is authoritative here — skip
              // the attach spawn entirely. Note --start's forked supervisor
              // may well complete on the host; the session then shows up via
              // --print-state discovery, which is exactly persistSessions
              // semantics. Defense in depth: also honor detachRequested in
              // case a future refactor makes removal async again.
              const live = supervisor.getSession(ws);
              if (!live || live.detachRequested) {
                log(`daemon: --start exited 0 but local client was closed during start — skipping attach spawn (host session, if created, persists)`);
                return;
              }
              log("daemon: --start exited 0, promoting to sandy --attach");
              try {
                const attachPty = spawnPty({
                  command: sandyBin!, args: attachArgs(ws),
                  cwd: ws, env,
                  cols: lastCols, rows: lastRows,
                });
                supervisor.promoteToAttach(ws, attachPty);
                panel.title = `Sandy (attached pid=${attachPty.pid})`;
                log(`daemon: attached pid=${attachPty.pid}`);
              } catch (e: any) {
                log(`daemon: --attach spawn failed: ${e?.message ?? e}`);
                supervisor.abortDaemonStart(ws, -1);
                vscode.window.showErrorMessage(`Sandy: failed to attach after --start (${e?.message ?? e})`);
              }
            } else {
              log(`daemon: --start failed exit=${code}`);
              supervisor.abortDaemonStart(ws, code);
              vscode.window.showErrorMessage(`Sandy: sandy --start failed (exit ${code}) — see terminal output`);
            }
          });
          break;
        }

        // Fresh spawn path. Stale-lock sweep first — VSCode reload / crash
        // interrupts sandy's cleanup trap and leaves locks behind that
        // block re-launch.
        let aliveLocks: string[] = [];
        try {
          const sweep = sweepStaleLocks(ws);
          if (sweep.cleaned.length) log(`cleaned ${sweep.cleaned.length} stale lock(s): ${sweep.cleaned.join(", ")}`);
          if (sweep.alive.length)   log(`live lock(s) detected: ${sweep.alive.join(", ")}`);
          if (sweep.unknown.length) log(`unparseable lock(s) left alone: ${sweep.unknown.join(", ")}`);
          aliveLocks = sweep.alive;
        } catch (e: any) {
          log(`lock sweep failed (continuing): ${e?.message ?? e}`);
        }

        // Orphan-from-prior-VSCode-session handling. If sandy is genuinely
        // running (live PID lock) but the supervisor has no session for
        // this workspace, we lost track of it across a VSCode restart /
        // crash / quit. Without sandy daemon-mode (rappdw/sandy#17), we
        // can't transparently re-attach. Offer the user the choice:
        // stop & restart fresh, or cancel.
        if (aliveLocks.length > 0) {
          const pids = aliveLocks
            .map(p => readLockPid(p)).filter((n): n is number => n != null);
          const pidLabel = pids.length ? `pid ${pids.join(", ")}` : "(unknown pid)";
          const choice = await vscode.window.showWarningMessage(
            `Sandy is already running for "${ws}" from outside this VSCode session.`,
            {
              modal: true,
              detail:
                `A live lock exists (${pidLabel}). This usually means a previous VSCode quit interrupted sandy's cleanup trap, ` +
                `or sandy was started outside sandy-ui. Sandy-ui can't transparently re-attach across VSCode restarts (yet — ` +
                `daemon-mode is tracked at github.com/rappdw/sandy/issues/17).\n\n` +
                `"Stop existing & launch fresh" SIGTERMs the running sandy (its cleanup trap will run docker stop / network rm), ` +
                `removes the lock, and starts a new session here.\n\n` +
                `"Cancel" leaves everything as-is — you can attach via terminal: \`sandy --workspace ${ws}\`.`,
            },
            "Stop existing & launch fresh",
          );
          if (choice !== "Stop existing & launch fresh") {
            log("user cancelled orphan resolution — aborting spawn");
            panel.dispose();
            return;
          }
          log(`force-stopping orphans: ${pids.join(", ")}`);
          await forceStopOrphans(aliveLocks, log);
        }

        const env = buildCleanEnv(approveEnv);
        log(`PATH: ${env.PATH}`);

        // Allow explicit override via workspace setting.
        const candidates = launchOverride
          ? [{ command: launchOverride.split(/\s+/)[0], args: launchOverride.split(/\s+/).slice(1) }]
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
      case "resize": {
        // Defense in depth against tab-switch squish: VSCode's iframe layout
        // collapses briefly during tab transitions, ResizeObserver fires on
        // the webview side with tiny dims, those get baked into tmux as
        // hard line wraps in scrollback (no reflow possible after the fact).
        // The webview side has its own guards (document.hidden, MIN_COLS,
        // element.clientWidth) but document.hidden races with ResizeObserver
        // in some VSCode versions. panel.visible is the authoritative
        // host-side signal — drop any resize while we know the tab isn't
        // visible. We schedule a refit on visible-restore separately
        // (panel.onDidChangeViewState below), so this is just suppression.
        if (!panel.visible) {
          log(`resize ${m.cols}x${m.rows} suppressed (panel not visible)`);
          break;
        }
        // Floor: anything below 20 cols is implausible for a real editor
        // pane and almost certainly a transition artifact that slipped past
        // the visibility check. Same threshold as the webview's MIN_COLS.
        if (m.cols < 20 || m.rows < 5) {
          log(`resize ${m.cols}x${m.rows} suppressed (below sanity floor)`);
          panel.webview.postMessage(<FromHost>{ type: "refit" });
          break;
        }
        log(`resize ${m.cols}x${m.rows}`);
        lastCols = m.cols;
        lastRows = m.rows;
        session?.pty.resize(m.cols, m.rows);
        break;
      }
      case "osc":    handleOsc(panel, m.event); break;
      case "openExternal": {
        // From the web-links addon (click on a detected URL). Scheme guard is
        // defense in depth: the addon's regex only matches http(s), but this
        // is a message from webview-context code — keep the host strict.
        let parsed: vscode.Uri | undefined;
        try { parsed = vscode.Uri.parse(m.uri, /* strict */ true); } catch { /* fall through */ }
        if (parsed && (parsed.scheme === "http" || parsed.scheme === "https")) {
          log(`openExternal: ${m.uri}`);
          void vscode.env.openExternal(parsed);
        } else {
          log(`openExternal REFUSED (non-http(s) scheme): ${m.uri}`);
        }
        break;
      }
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
    cfgSub.dispose();
    if (!session) return;
    // If supervisor's session.panel === undefined OR points elsewhere,
    // this dispose is from a detach (already handled) or from a stale
    // close (another panel took over) — don't kill.
    if (session.panel !== panel) {
      log(`tab disposed but session is detached/reassigned for ${ws} — leaving PTY alive`);
      return;
    }
    if (session.backend === "daemon") {
      // Daemon sessions survive the tab close by design — the host-side
      // session is durable; the local attach client is the only thing
      // going away. detach() sets detachRequested BEFORE killing that
      // client, so the supervisor's exit wiring treats it as a clean
      // detach rather than a session death.
      log("tab closed — detached daemon client (session persists; use Stop to tear down)");
      supervisor.detach(ws);
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
      // Clear the OSC-notification badge — ● means "unseen activity", and
      // the user just looked (review finding B7).
      if (panel.title.startsWith("● ")) panel.title = panel.title.slice(2);
      panel.webview.postMessage({ type: "refit" });
    }
  });
}

// Reads sandy.launch.close{BottomPanel,AuxiliaryBar,Sidebar} settings and
// fires VSCode's built-in close commands for whichever are enabled. All
// errors are swallowed — this is best-effort UX, never blocks the launch.
// SIGTERM each lock's PID to give sandy.sh's cleanup trap a chance to run
// (docker stop, docker network rm), wait briefly, then force-remove any
// surviving lock files so the subsequent spawn isn't blocked. Best-effort:
// each step is wrapped in try/catch and we always proceed to the spawn.
async function forceStopOrphans(aliveLockPaths: string[], log: (m: string) => void): Promise<void> {
  for (const lockPath of aliveLockPaths) {
    const pid = readLockPid(lockPath);
    if (pid == null) continue;
    if (!isPidAlive(pid)) { log(`orphan pid ${pid} already gone, skipping signal`); continue; }
    try {
      process.kill(pid, "SIGTERM");
      log(`SIGTERM sent to orphan pid ${pid}`);
    } catch (e: any) {
      log(`SIGTERM to pid ${pid} failed: ${e?.message ?? e}`);
    }
  }

  // Give sandy's cleanup trap a chance to run (docker stop is slow). 3s is
  // a balance between cleanup completion and user-perceived launch latency.
  await new Promise(r => setTimeout(r, 3_000));

  for (const lockPath of aliveLockPaths) {
    if (!fs.existsSync(lockPath)) { log(`orphan lock cleaned by sandy's trap: ${lockPath}`); continue; }
    try {
      fs.rmSync(lockPath, { recursive: true, force: true });
      log(`force-removed orphan lock: ${lockPath}`);
    } catch (e: any) {
      log(`failed to remove orphan lock ${lockPath}: ${e?.message ?? e}`);
    }
  }
}

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

