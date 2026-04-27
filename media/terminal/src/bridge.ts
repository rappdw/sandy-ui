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
  | { type: "exit"; code: number };

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
      theme: { background: "#1e1e1e", foreground: "#d4d4d4" },
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
  const sendResize = (): void => {
    try { fit.fit(); }
    catch (e) {
      const err = e as { message?: string };
      log("fit failed", err?.message ?? String(e));
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
