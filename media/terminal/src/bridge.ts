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
  | { type: "openExternal"; uri: string }
  | { type: "log";    level: "info" | "error"; msg: string };

type FromHost =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | { type: "refit" }
  | { type: "scrollSensitivity"; value: number };

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

  // User-facing wheel-speed multiplier (sandy.terminal.scrollSensitivity).
  // 1 = the tuned defaults below; >1 scrolls faster, <1 finer. The host posts
  // the current value on launch and again whenever the setting changes.
  let scrollSensitivity = 1;
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
      // We intercept tmux's mouse-tracking enables below (see "split mouse"
      // section) so xterm never forwards click/drag — plain drag selects
      // natively, no modifier needed. macOptionClickForcesSelection stays on
      // purely so ⌥-drag does NOT fall into xterm's column-select (crosshair)
      // mode; with mouse tracking suppressed, ⌥ is otherwise a no-op.
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
    });
    log("Terminal constructed");
    fit   = new FitAddon.FitAddon();
    // Explicit link handler: route through the host → vscode.env.openExternal.
    // The addon's DEFAULT handler does `window.open()` with no URL and then
    // sets location on the popup — a VSCode webview returns null for a
    // URL-less window.open (nothing to intercept/forward), so links silently
    // did nothing (console.warn only, invisible outside devtools).
    links = new WebLinksAddon.WebLinksAddon((_event: MouseEvent, uri: string) => {
      post({ type: "openExternal", uri });
    });
    void links;  // referenced to silence unused warning
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

  // ---- Split mouse: native selection + wheel-to-tmux + clean fullscreen -----
  // tmux's "mouse on" is one terminal-level switch that bundles two things:
  // mouse TRACKING (click/drag → forwarded to the app, which suppresses
  // xterm's native selection) and the WHEEL (scroll → forwarded to the app).
  // Leaving it on means you must hold ⌥ to select; turning it off kills wheel
  // scroll inside tmux. We split the switch so you get all three at once:
  // native drag-to-select with no modifier, wheel still scrolls tmux, and
  // fullscreen TUIs (claude, vim) still render/restore cleanly.
  //
  //   (1) Swallow the mouse-TRACKING DECSET/DECRST modes (9/1000/1001/1002/
  //       1003) so xterm never enters mouse mode and never forwards click/drag
  //       → selection is always native. Everything else — crucially alt-screen
  //       (1049), bracketed paste (2004), app cursor keys — passes straight
  //       through, so fullscreen rendering is untouched.
  //   (2) Re-inject ONLY the wheel as SGR mouse events directly to the PTY, so
  //       tmux (whose own `mouse on` we never disabled — it just never saw us
  //       hide the enable from xterm) still scrolls on wheel.
  //
  // Cost: clicking INSIDE a TUI app no longer reaches it — only wheel and the
  // keyboard do. Selection-over-app-click is the deliberate trade for sandy.
  try {
    if (!term.parser) throw new Error("term.parser undefined");

    // DECSET/DECRST private modes that turn on mouse *tracking* (not encoding
    // modes like 1006 SGR, which are harmless to leave). Swallowing these is
    // what keeps drag native.
    const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003]);

    // True while the inner app has asked for mouse tracking (i.e. we swallowed
    // an enable). Used to decide whether the wheel should be re-injected to the
    // app or left to xterm's own scrollback handling at a bare prompt.
    let appWantsMouse = false;

    // params entries can be number | number[] (sub-params); compare on heads.
    // (DECSET params carry no sub-params in practice, so heads are enough to
    // reconstruct the passthrough sequence below.)
    const splitModes = (params: (number | number[])[]) => {
      const heads = params.map((p) => (Array.isArray(p) ? p[0] : p));
      return {
        tracking: heads.filter((c) => MOUSE_TRACKING_MODES.has(c)),
        rest:     heads.filter((c) => !MOUSE_TRACKING_MODES.has(c)),
      };
    };

    // Most-recently-added CSI handler runs FIRST; returning true consumes the
    // sequence so xterm's built-in DECSET/DECRST never runs (mouse mode stays
    // off). Mixed sequences (tracking + other modes in one CSI, e.g.
    // `?1000;1006h`) are split: consume the whole thing, flip our tracking
    // state, and re-inject the non-tracking modes via term.write so xterm
    // still applies them. term.write is queue-based, so writing from inside a
    // parser callback is safe — it's appended after the current chunk.
    // Previously a mixed sequence passed through whole and quietly re-enabled
    // mouse tracking, breaking native selection (review finding B10).
    const makeDecModeHandler = (final: "h" | "l") => (params: (number | number[])[]): boolean => {
      const { tracking, rest } = splitModes(params);
      if (tracking.length === 0) return false;  // nothing of ours — xterm handles it
      appWantsMouse = final === "h";
      if (rest.length > 0) term.write(`\x1b[?${rest.join(";")}${final}`);
      return true;
    };
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, makeDecModeHandler("h"));
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, makeDecModeHandler("l"));

    // Trackpad inertia spills a phantom wheel event right at the end of a
    // selection drag (the tail of the two-finger gesture). Without this guard
    // that stray wheel would run the scroll/clear path below and wipe the
    // selection the user just released — intermittently, depending on momentum.
    // Record each mouseup and ignore wheel for a brief window afterward.
    let lastMouseUpAt = -Infinity;
    const POST_MOUSEUP_WHEEL_GUARD_MS = 200;
    document.addEventListener("mouseup", () => { lastMouseUpAt = performance.now(); }, true);

    // Pixel-mode accumulator. Trackpads (and smooth-scroll mice) fire a stream
    // of small deltas; flooring each to a whole line would overshoot and ruin
    // fine control. Instead we bank pixels here and only emit lines once the
    // running total crosses a line height — so a gentle nudge scrolls a little,
    // not a full line per event.
    let wheelAccumPx = 0;

    // Translate the wheel into SGR mouse events for the app. When nothing has
    // asked for mouse (bare prompt), return true so xterm scrolls its own
    // scrollback normally.
    term.attachCustomWheelEventHandler((ev: WheelEvent): boolean => {
      // Pure-horizontal events (deltaY 0) aren't ours: don't inject, don't
      // reset the vertical bank — just let xterm ignore them (finding B11).
      if (ev.deltaY === 0) return true;
      if (!appWantsMouse) return true;
      // Within the post-selection guard window: swallow without injecting or
      // clearing, so releasing a selection never scrolls or drops it.
      if (performance.now() - lastMouseUpAt < POST_MOUSEUP_WHEEL_GUARD_MS) return false;
      const el = document.getElementById("terminal");
      if (!el || term.cols < 1 || term.rows < 1) return true;
      const rect = el.getBoundingClientRect();
      const cellW = rect.width / term.cols;
      const cellH = rect.height / term.rows;
      if (cellW <= 0 || cellH <= 0) return true;
      const col = Math.min(term.cols, Math.max(1, Math.floor((ev.clientX - rect.left) / cellW) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((ev.clientY - rect.top) / cellH) + 1));
      // Two device profiles share the wheel, and they want opposite things:
      //   - Trackpads fire a stream of small pixel deltas → accumulate them so
      //     sub-line movements bank up (fine control, no per-event overshoot).
      //   - A mouse wheel fires a few big notches → emit lines immediately so
      //     it feels snappy, not laggy.
      // Branch on delta size. NOTCH_PX is the threshold between "smooth dribble"
      // and "discrete notch". COARSE divisor sets lines-per-notch (snappy);
      // FINE divisor sets the trackpad accumulation rate (slow = fine).
      // scrollSensitivity scales speed by shrinking the px-per-line divisors
      // (higher sensitivity → fewer px per line → faster) and raising the cap
      // so a fast flick isn't bottlenecked. Clamp to a sane range.
      const sens = Math.min(10, Math.max(0.1, scrollSensitivity));
      const FINE_PIXELS_PER_LINE = 70 / sens;
      const COARSE_PIXELS_PER_LINE = 25 / sens;
      const NOTCH_PX = 50;
      const MAX_LINES_PER_EVENT = Math.ceil(5 * sens);

      let lines: number;
      let btn: number; // 64 = wheel up, 65 = wheel down
      if (ev.deltaMode === 0 && Math.abs(ev.deltaY) < NOTCH_PX) {
        // Trackpad: accumulate sub-line deltas.
        // Reset the bank on a direction change so a reversal responds instantly.
        if ((wheelAccumPx > 0) !== (ev.deltaY > 0)) wheelAccumPx = 0;
        wheelAccumPx += ev.deltaY;
        const whole = Math.trunc(wheelAccumPx / FINE_PIXELS_PER_LINE);
        if (whole === 0) return false; // not enough banked yet — swallow, don't scroll
        wheelAccumPx -= whole * FINE_PIXELS_PER_LINE;
        lines = Math.min(MAX_LINES_PER_EVENT, Math.abs(whole));
        btn = whole < 0 ? 64 : 65;
      } else {
        // Discrete wheel notch (large pixel delta) or line/page mode: emit now.
        wheelAccumPx = 0; // drop any stale trackpad bank
        const px = ev.deltaMode === 0 ? Math.abs(ev.deltaY) : Math.abs(ev.deltaY) * COARSE_PIXELS_PER_LINE;
        lines = Math.min(MAX_LINES_PER_EVENT, Math.max(1, Math.round(px / COARSE_PIXELS_PER_LINE)));
        btn = ev.deltaY < 0 ? 64 : 65;
      }
      let seq = "";
      for (let i = 0; i < lines; i++) seq += `\x1b[<${btn};${col};${row}M`;
      post({ type: "input", data: seq });
      // tmux repaints the screen in place in response — xterm sees new chars in
      // the same cells, not a scroll, so a live selection would stay painted
      // over now-different text. Clear it, matching native terminal behavior
      // where scrolling drops the selection.
      if (term.hasSelection()) term.clearSelection();
      return false; // handled — suppress xterm's own (alt-screen) wheel behavior
    });
    log("split-mouse handlers registered");
  } catch (e) {
    // Non-fatal — basic terminal output and keyboard still work without this.
    fail("split-mouse setup (non-fatal)", e);
  }

  // ---- Keyboard focus -------------------------------------------------------
  // VSCode focuses the webview IFRAME when the tab activates or the window
  // regains OS focus — but keystrokes only reach the PTY when xterm's hidden
  // helper textarea inside the iframe is focused. Without this forwarding,
  // launch and Cmd+Tab-back both land on a focused iframe with an unfocused
  // terminal, and the user needs one extra click before typing works.
  // The iframe only receives this focus event when VSCode actually chose it,
  // so forwarding never steals focus from the sidebar/editors.
  window.addEventListener("focus", () => {
    try { term.focus(); } catch { /* not fatal */ }
  });

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
    } else if (m.type === "scrollSensitivity") {
      if (typeof m.value === "number" && isFinite(m.value)) {
        scrollSensitivity = m.value;
        log("scrollSensitivity =", scrollSensitivity);
      }
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
    // Initial focus: at panel creation VSCode may have focused the iframe
    // BEFORE our window-focus listener existed — focus explicitly so typing
    // works immediately after launch, no click required.
    try { term.focus(); } catch { /* not fatal */ }
  }));
})();
