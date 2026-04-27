// Webview-side bridge: instantiates xterm.js, wires OSC handlers, and
// proxies bytes to/from the extension host over the postMessage channel.
//
// Globals provided by the script tags in webviewPanel.ts:
//   Terminal           (xterm)
//   FitAddon           (addon-fit, factory class)
//   WebLinksAddon      (addon-web-links, factory class)
//   acquireVsCodeApi   (VSCode webview)

(() => {
  "use strict";

  // Print to the document so failures are visible even without devtools.
  const showFatal = (msg) => {
    const pre = document.createElement("pre");
    pre.style.cssText = "color:#f48771;background:#1e1e1e;padding:12px;margin:0;font-family:Menlo,monospace;font-size:12px;white-space:pre-wrap;";
    pre.textContent = "[bridge.js fatal]\n" + msg;
    document.body.appendChild(pre);
  };

  let vscode;
  try { vscode = acquireVsCodeApi(); }
  catch (e) { showFatal("acquireVsCodeApi failed: " + e); return; }

  const log = (...args) => {
    try { console.log("[bridge]", ...args); } catch {}
    try { vscode.postMessage({ type: "log", level: "info", msg: args.map(String).join(" ") }); } catch {}
  };
  const fail = (where, e) => {
    const msg = `${where}: ${e?.message ?? e}\n${e?.stack ?? ""}`;
    showFatal(msg);
    try { vscode.postMessage({ type: "log", level: "error", msg }); } catch {}
  };

  // Verify globals before constructing.
  log("globals", { Terminal: typeof Terminal, FitAddon: typeof FitAddon, WebLinksAddon: typeof WebLinksAddon });
  if (typeof Terminal !== "function") return fail("globals", "Terminal not loaded — xterm.js script tag failed");

  let term, fit, links;
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
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(document.getElementById("terminal"));
    log("Terminal opened, cols/rows", term.cols, term.rows);
  } catch (e) { return fail("Terminal init", e); }

  // ---- OSC handlers ---------------------------------------------------------
  try {
    if (!term.parser) throw new Error("term.parser is undefined (allowProposedApi may not be honored)");

    term.parser.registerOscHandler(9, (data) => {
      vscode.postMessage({ type: "osc", event: { kind: "notification", code: 9, title: data } });
      return true;
    });
    term.parser.registerOscHandler(99, (data) => {
      const i = data.lastIndexOf(";");
      const head = i >= 0 ? data.slice(0, i) : "";
      const body = i >= 0 ? data.slice(i + 1) : data;
      vscode.postMessage({ type: "osc", event: { kind: "notification", code: 99, title: head || "(notification)", body } });
      return true;
    });
    term.parser.registerOscHandler(777, (data) => {
      const parts = data.split(";");
      const ev = parts[0] === "notify"
        ? { kind: "notification", code: 777, title: parts[1] || "", body: parts[2] }
        : { kind: "notification", code: 777, title: data };
      vscode.postMessage({ type: "osc", event: ev });
      return true;
    });
    term.parser.registerOscHandler(52, (data) => {
      const semi = data.indexOf(";");
      if (semi < 0) return true;
      const target = data.slice(0, semi);
      const payload = data.slice(semi + 1);
      if (payload === "?") return true;
      let decoded;
      try { decoded = atob(payload); } catch { return true; }
      vscode.postMessage({ type: "osc", event: { kind: "clipboard", target, data: decoded } });
      return true;
    });
    term.parser.registerOscHandler(0, (data) => {
      vscode.postMessage({ type: "osc", event: { kind: "title", title: data } });
      return false;
    });
    log("OSC handlers registered");
  } catch (e) {
    // Don't fail hard — registering OSC handlers is not required for basic terminal output.
    fail("OSC handler registration (non-fatal)", e);
  }

  // ---- Wire input + resize -------------------------------------------------
  term.onData((data) => vscode.postMessage({ type: "input", data }));

  let lastCols = 0, lastRows = 0;
  const sendResize = () => {
    try { fit.fit(); }
    catch (e) { log("fit failed", e?.message); }
    if (term.cols === lastCols && term.rows === lastRows) return;
    lastCols = term.cols; lastRows = term.rows;
    vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
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
  ro.observe(document.getElementById("terminal"));
  window.addEventListener("resize", sendResize);

  // ---- Receive PTY bytes ---------------------------------------------------
  let writes = 0;
  window.addEventListener("message", (e) => {
    const m = e.data;
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
    try { fit.fit(); } catch (e) { log("initial fit failed", e?.message); }
    lastCols = term.cols; lastRows = term.rows;
    log("posting ready", term.cols, "x", term.rows);
    vscode.postMessage({ type: "ready", cols: term.cols, rows: term.rows });
  }));
})();
