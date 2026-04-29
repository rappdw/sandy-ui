// Webview-side bridge: instantiates xterm.js, wires OSC handlers, and proxies
// bytes to/from the extension host over the postMessage channel.
//
// Globals (declared in /media/types.d.ts) are loaded by <script> tags in
// webviewPanel.ts's HTML — esbuild bundles us as IIFE and references them
// as bare identifiers; the script-tag order guarantees they exist at runtime.

export {}; // mark as module so local types don't leak into global scope

// ---- Message contracts ----------------------------------------------------
// Mirrors the host-side ToHost / FromHost types in src/terminal/webviewPanel.ts.
// Kept structural (no shared file) because host code is Node-targeted and this
// is browser-targeted; duplication is cheap, coupling is not.

type OscEvent =
  | { kind: "notification"; code: 9 | 99 | 777; title: string; body?: string }
  | { kind: "clipboard";    target: string; data: string }
  | { kind: "title";        title: string };

type ToHost =
  | { type: "ready";  cols: number; rows: number }
  | { type: "input";  data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "osc";    event: OscEvent }
  | { type: "log";    level: "info" | "error"; msg: string };

type FromHost =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "refit" };

// ---------------------------------------------------------------------------

(() => {
  "use strict";

  // Print to the document so failures are visible even without devtools.
  const showFatal = (msg: string): void => {
    const pre = document.createElement("pre");
    pre.style.cssText =
      "color:#f48771;background:#1e1e1e;padding:12px;margin:0;" +
      "font-family:Menlo,monospace;font-size:12px;white-space:pre-wrap;";
    pre.textContent = "[bridge.ts fatal]\n" + msg;
    document.body.appendChild(pre);
  };

  let vscode: import("../../types").VSCodeApi;
  try { vscode = acquireVsCodeApi(); }
  catch (e) { showFatal("acquireVsCodeApi failed: " + String(e)); return; }

  const post = (m: ToHost) => vscode.postMessage(m);
  const log = (...args: unknown[]) => {
    try { console.log("[bridge]", ...args); } catch { /* swallow */ }
    try { post({ type: "log", level: "info", msg: args.map(String).join(" ") }); } catch { /* swallow */ }
  };
  const fail = (where: string, e: unknown) => {
    const err = e as { message?: string; stack?: string } | undefined;
    const msg = `${where}: ${err?.message ?? String(e)}\n${err?.stack ?? ""}`;
    showFatal(msg);
    try { post({ type: "log", level: "error", msg }); } catch { /* swallow */ }
  };

  // Verify globals before constructing.
  log("globals", { Terminal: typeof Terminal, FitAddon: typeof FitAddon, WebLinksAddon: typeof WebLinksAddon });
  if (typeof Terminal !== "function") {
    fail("globals", new Error("Terminal not loaded — xterm.js script tag failed"));
    return;
  }

  // Build an xterm.js theme. Strategy: prefer VSCode's terminal CSS
  // variables when available (matches the user's active theme), fall
  // back to a curated dark palette with deliberately stronger brightBlack
  // than xterm.js's default — that's the gray tmux uses for status bar
  // dim text and ls colors, and xterm.js's default washes it out.
  //
  // CSS custom properties cascade DOWN, not up — VSCode injects
  // --vscode-* vars on document.body, so reading from documentElement
  // (html) returns empty. Read from body. Walk up the chain for safety.
  const cssVar = (name: string, fallback: string): string => {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const v = getComputedStyle(el).getPropertyValue(name).trim();
      if (v) return v;
    }
    return fallback;
  };

  // Diagnostic: probe a known VSCode webview variable so we can tell
  // (in the output channel) whether VSCode-vars are exposed at all.
  // --vscode-editor-background is universally exposed in webviews.
  const sentinel = cssVar("--vscode-editor-background", "");
  log("css-vars: --vscode-editor-background =", sentinel || "(empty)");
  log("css-vars: --vscode-terminal-background =", cssVar("--vscode-terminal-background", "(empty)"));
  log("css-vars: --vscode-terminal-ansiBrightBlack =", cssVar("--vscode-terminal-ansiBrightBlack", "(empty)"));

  // Black (ANSI 0) and brightBlack (ANSI 8) are both forced regardless of
  // what VSCode's vars say. Claude Code's output uses ANSI 0 for assistant
  // text; VSCode's --vscode-terminal-ansiBlack is #000000 on Dark+, which
  // is pure-black on a #1e1e1e background — visually unreadable. We pin
  // both to greys with guaranteed contrast against any dark background.
  // Background/foreground/cursor still adapt to the VSCode theme.
  const xtermTheme = {
    background:                cssVar("--vscode-terminal-background",                    "#1e1e1e"),
    foreground:                cssVar("--vscode-terminal-foreground",                    "#d4d4d4"),
    cursor:                    cssVar("--vscode-terminalCursor-foreground",              "#d4d4d4"),
    cursorAccent:              cssVar("--vscode-terminalCursor-background",              "#1e1e1e"),
    // Selection colors are hardcoded (not pulled from VSCode CSS vars).
    // VSCode exposes --vscode-terminal-selectionBackground as rgba with
    // alpha (e.g. rgba(38,79,120,0.5) on Dark+); xterm.js's theme parser
    // doesn't reliably apply alpha selection colors and ends up rendering
    // selection as invisible — which looks identical to "selection broken"
    // since Cmd+C still works but the user gets no visual feedback. Pin
    // to a solid navy that's guaranteed visible against any dark bg.
    selectionBackground:       "#264f78",
    selectionInactiveBackground: "#3a3d41",
    selectionForeground:       "#ffffff",
    black:                     "#7a7a7a",
    red:                       cssVar("--vscode-terminal-ansiRed",                       "#cd3131"),
    green:                     cssVar("--vscode-terminal-ansiGreen",                     "#0dbc79"),
    yellow:                    cssVar("--vscode-terminal-ansiYellow",                    "#e5e510"),
    blue:                      cssVar("--vscode-terminal-ansiBlue",                      "#2472c8"),
    magenta:                   cssVar("--vscode-terminal-ansiMagenta",                   "#bc3fbc"),
    cyan:                      cssVar("--vscode-terminal-ansiCyan",                      "#11a8cd"),
    white:                     cssVar("--vscode-terminal-ansiWhite",                     "#e5e5e5"),
    brightBlack:               "#a0a0a0",
    brightRed:                 cssVar("--vscode-terminal-ansiBrightRed",                 "#f14c4c"),
    brightGreen:               cssVar("--vscode-terminal-ansiBrightGreen",               "#23d18b"),
    brightYellow:              cssVar("--vscode-terminal-ansiBrightYellow",              "#f5f543"),
    brightBlue:                cssVar("--vscode-terminal-ansiBrightBlue",                "#3b8eea"),
    brightMagenta:             cssVar("--vscode-terminal-ansiBrightMagenta",             "#d670d6"),
    brightCyan:                cssVar("--vscode-terminal-ansiBrightCyan",                "#29b8db"),
    brightWhite:               cssVar("--vscode-terminal-ansiBrightWhite",               "#e5e5e5"),
  };
  log("xterm theme background/brightBlack:", xtermTheme.background, xtermTheme.brightBlack);

  let term: InstanceType<typeof Terminal>;
  let fit:  InstanceType<typeof FitAddon.FitAddon>;
  let links: InstanceType<typeof WebLinksAddon.WebLinksAddon>;
  try {
    term = new Terminal({
      cursorBlink:    true,
      convertEol:     false,
      scrollback:     10000,
      allowProposedApi: true,
      fontFamily:     'Menlo, Consolas, "Courier New", monospace',
      fontSize:       13,
      theme:          xtermTheme,
    });
    log("Terminal constructed");
    fit   = new FitAddon.FitAddon();
    links = new WebLinksAddon.WebLinksAddon();
    void links;  // loaded for side effect; reference to silence unused warning
    term.loadAddon(fit);
    term.loadAddon(links);
    const host = document.getElementById("terminal");
    if (!host) throw new Error("#terminal element missing from webview HTML");
    term.open(host);
    log("Terminal opened, cols/rows", term.cols, term.rows);
  } catch (e) { return fail("Terminal init", e); }

  // ---- OSC handlers ---------------------------------------------------------
  try {
    if (!term.parser) {
      throw new Error("term.parser is undefined (allowProposedApi may not be honored)");
    }

    term.parser.registerOscHandler(9, (data: string) => {
      post({ type: "osc", event: { kind: "notification", code: 9, title: data } });
      return true;
    });
    term.parser.registerOscHandler(99, (data: string) => {
      const i = data.lastIndexOf(";");
      const head = i >= 0 ? data.slice(0, i) : "";
      const body = i >= 0 ? data.slice(i + 1) : data;
      post({ type: "osc", event: { kind: "notification", code: 99, title: head || "(notification)", body } });
      return true;
    });
    term.parser.registerOscHandler(777, (data: string) => {
      const parts = data.split(";");
      const ev: OscEvent = parts[0] === "notify"
        ? { kind: "notification", code: 777, title: parts[1] || "", body: parts[2] }
        : { kind: "notification", code: 777, title: data };
      post({ type: "osc", event: ev });
      return true;
    });
    term.parser.registerOscHandler(52, (data: string) => {
      const semi = data.indexOf(";");
      if (semi < 0) return true;
      const target = data.slice(0, semi);
      const payload = data.slice(semi + 1);
      if (payload === "?") return true;
      let decoded: string;
      try { decoded = atob(payload); } catch { return true; }
      post({ type: "osc", event: { kind: "clipboard", target, data: decoded } });
      return true;
    });
    term.parser.registerOscHandler(0, (data: string) => {
      post({ type: "osc", event: { kind: "title", title: data } });
      return false;
    });
    log("OSC handlers registered");
  } catch (e) {
    // Don't fail hard — OSC handlers are not required for basic terminal output.
    fail("OSC handler registration (non-fatal)", e);
  }

  // ---- Wire input + resize --------------------------------------------------
  term.onData((data: string) => post({ type: "input", data }));

  let lastCols = 0, lastRows = 0;
  // Below-this is treated as a layout-transition artifact, not a real user
  // resize. tmux running under sandy hard-wraps lines at the inner pty
  // width — if we forward a 30-col resize during a tab hide/show transition,
  // tmux re-renders the screen narrow and bakes those hard newlines into
  // xterm's scrollback (no reflow possible after that, even if we resize
  // back wide). 20 cols is an aggressive minimum that no legitimate VSCode
  // editor-area pane would shrink below.
  const MIN_COLS = 20;
  const MIN_ROWS = 5;
  const sendResize = (): void => {
    // Suppress while the tab is hidden — VSCode collapses our iframe during
    // tab transitions and ResizeObserver fires with bogus tiny dims. The
    // visibilitychange→forceRefit path measures + sends on the way back.
    if (document.hidden) return;

    // Suppress when the terminal element itself reports near-zero size.
    // Same defense as document.hidden, but catches cases where the iframe
    // is technically "visible" mid-transition while still squashed.
    const el = document.getElementById("terminal");
    if (el && (el.clientWidth < 50 || el.clientHeight < 30)) return;

    try { fit.fit(); }
    catch (e) {
      const err = e as { message?: string };
      log("fit failed", err?.message ?? String(e));
    }

    // Reject implausible fit results (transition artifacts that slipped
    // through the visibility/element-size guards). The next legitimate
    // ResizeObserver fire will resend with real dims.
    if (term.cols < MIN_COLS || term.rows < MIN_ROWS) {
      log(`sendResize: ignoring squished ${term.cols}x${term.rows}`);
      return;
    }

    if (term.cols === lastCols && term.rows === lastRows) return;
    lastCols = term.cols; lastRows = term.rows;
    post({ type: "resize", cols: term.cols, rows: term.rows });
  };

  // window.resize alone misses VSCode's post-render layout pass, leaving the
  // PTY stuck at xterm.js's default 80x24. ResizeObserver catches container
  // changes including the initial layout settling.
  let rafScheduled = false;
  const ro = new ResizeObserver(() => {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; sendResize(); });
  });
  const terminalEl = document.getElementById("terminal");
  if (terminalEl) ro.observe(terminalEl);
  window.addEventListener("resize", sendResize);

  // ---- Forced refit on visibility-restore ---------------------------------
  // When the user switches to a different editor tab and back to Sandy, the
  // iframe briefly hits zero width and xterm.js settles to a "squished few
  // cols" state. ResizeObserver doesn't re-fire on the way back (size
  // matches the squished value from xterm's perspective). Two paths into
  // refit: (a) host posts {type:"refit"} via onDidChangeViewState, (b)
  // document.visibilitychange as a backup if the host signal misses.
  // Both wait two rAFs so VSCode's layout settles before fit.fit() measures.
  const forceRefit = (reason: string) => {
    // Three rAFs (was two): the visibility-restore path needs an extra
    // tick for VSCode's iframe to finish re-expanding. Two ticks left us
    // measuring during the layout settle and produced the same tiny dims
    // we were trying to recover from.
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      const before = `${term.cols}x${term.rows}`;
      // Reset lastCols/lastRows so sendResize doesn't short-circuit if fit
      // happens to land on the same numbers we last reported.
      lastCols = 0; lastRows = 0;
      try { fit.fit(); }
      catch (e) { const err = e as { message?: string }; log("refit fit failed", err?.message ?? String(e)); }
      const after = `${term.cols}x${term.rows}`;
      log(`refit (${reason}): ${before} → ${after}`);
      sendResize();
    })));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") forceRefit("visibilitychange");
  });

  // ---- Receive PTY bytes ---------------------------------------------------
  let writes = 0;
  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as FromHost;
    if (m.type === "data") {
      writes++;
      if (writes <= 3) log("term.write chunk #" + writes + " (" + m.data.length + " bytes)");
      term.write(m.data);
    } else if (m.type === "exit") {
      term.write(`\r\n\x1b[2m[process exited ${m.code}]\x1b[0m\r\n`);
    } else if (m.type === "refit") {
      forceRefit("host");
    }
  });

  // ---- Initial handshake ---------------------------------------------------
  // Wait two rAFs so VSCode's webview layout has settled before fit.fit()
  // measures the container — otherwise we hand the host stale 80x24 dims and
  // sandy renders into a tiny corner of the tab.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { fit.fit(); } catch (e) {
      const err = e as { message?: string };
      log("initial fit failed", err?.message ?? String(e));
    }
    lastCols = term.cols; lastRows = term.rows;
    log("posting ready", term.cols, "x", term.rows);
    post({ type: "ready", cols: term.cols, rows: term.rows });
  }));
})();
