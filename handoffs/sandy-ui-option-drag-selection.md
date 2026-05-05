# Diagnose: Option-drag selection not working in Sandy webview

> **Purpose**: paste the body of this file as the prompt to a fresh Claude
> Code (or other coding agent) session inside the sandy-ui repo
> (`github.com/rappdw/sandy-ui`). Self-delegation — the work is sandy-ui-
> side, but the diagnosis path is involved enough that handing it to a
> fresh agent with full context beats trying to push through it inline.

---

I'm working on **sandy-ui**, a VSCode extension that hosts the [sandy](https://github.com/rappdw/sandy) CLI inside a webview-as-editor-tab using xterm.js. There's a click-to-select bug I need diagnosed and fixed.

## Symptom

In the Sandy webview tab on macOS, **click-and-drag selects no text**. Holding ⌥ Option while dragging also selects nothing — though the cursor changes to a crosshair on Option-keydown (the cursor change is xterm.js's normal Alt-keydown behavior and doesn't tell us whether selection-forcing is active).

Cmd+C does nothing because nothing is highlighted. Programs running inside sandy's tmux work fine; only host-side selection is broken.

## What we already know

- `sandy` runs `tmux` inside its container with `set -g mouse on`, which means click-drag inside the terminal is consumed by tmux (for pane-resize / copy-mode entry) and xterm.js's native selection is suppressed.
- xterm.js exposes `macOptionClickForcesSelection` for exactly this case — when true, holding Option overrides mouse-event forwarding and forces native selection.
- I previously added it in `media/terminal/src/bridge.ts` (commit `a31cd09`):
  ```ts
  macOptionClickForcesSelection: true,
  rightClickSelectsWord: true,
  ```
- xterm 5.5.0 (which sandy-ui uses) ships this option. I verified the runtime guard: `shouldForceSelection(e) { return d.isMac ? e.altKey && this._optionsService.rawOptions.macOptionClickForcesSelection : e.shiftKey }` — so it requires `e.altKey` true AND the option set AND xterm's `isMac` detection succeeding (UA-sniff against `navigator.platform`).
- A queued sandy-side fix (`handoffs/sandy-tmux-mouse-and-passthrough.md`) would disable tmux mouse mode when sandy is launched by a host that owns selection, but that's not landed and isn't the right fix to chase first.

## What I need from you

Diagnose and fix so click-drag (with or without Option held) produces a visible text selection that Cmd+C can copy. In rough order:

1. **Verify the installed bundle.** The webview loads `media/terminal/dist/bridge.js`, bundled by esbuild from `media/terminal/src/bridge.ts`. Confirm:
   - `git log --oneline -1 -- media/terminal/src/bridge.ts` is at `a31cd09` or later.
   - `grep -c macOptionClickForcesSelection media/terminal/dist/bridge.js` > 0 in the **dev tree** AND in the **installed extension** at `~/.vscode/extensions/rappdw.sandy-ui-*/media/terminal/dist/bridge.js`. If 0 in either, that's the bug — `npm run install-vsix` rebuilds via `npm run compile` → esbuild → `media/{terminal,settings}/dist/`. May also need a full `code --uninstall-extension rappdw.sandy-ui` first if VSCode is caching.
   - The vendored xterm at `media/terminal/vendor/xterm.js` (copied from `node_modules/@xterm/xterm/lib/xterm.js` by `scripts/copy-xterm.js`) contains `macOptionClickForcesSelection`. If not, run `npm run copy-xterm`.

2. **Add a runtime diagnostic so the actual applied option is visible without devtools.** sandy-ui forwards webview `console.log` to the "Sandy" output channel via `post({type:"log", level:"info", msg:...})`. Right after `term.open(host)` in `bridge.ts`, log:
   ```ts
   log("selection options:",
     "macOptionClickForcesSelection=", (term.options as any).macOptionClickForcesSelection,
     "rightClickSelectsWord=", (term.options as any).rightClickSelectsWord,
     "navigator.platform=", navigator.platform);
   ```
   Reinstall, reload window, open Sandy, check the Sandy output channel.
   - If `macOptionClickForcesSelection=true` and `navigator.platform` contains "Mac" but Option-drag still doesn't select, then xterm 5.5's option isn't being honored in this environment and we need a different approach — see step 3.
   - If the line doesn't appear at all, the bundle in the installed extension is stale (or older bridge.ts code is loading); fix the install pipeline.

3. **If the option is verifiably set but selection still doesn't work**, the fallback approach is to bypass tmux mouse mode entirely from the host side. Two options, in increasing invasiveness:
   - **Inject `printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l'` into the PTY** on session start to disable mouse-tracking modes. This works for a fresh tmux session but tmux may re-enable on reattach. Also unnecessarily bypasses tmux mouse for users who want it inside copy-mode.
   - **Set `SANDY_TMUX_MOUSE=off` (or similar) on spawn** — doesn't exist yet on the sandy side. The handoff at `handoffs/sandy-tmux-mouse-and-passthrough.md` proposes the env-var-gated approach. If you take this path, write a minimal version of the env-var-set in `src/terminal/supervisor.ts` and document that the sandy-side change needs to land for it to take effect — don't try to monkey-patch the tmux config from sandy-ui's side.

4. **Sanity-check there's no JS error in the webview** that's killing initialization before the term constructor runs. The bridge has a top-level error handler that posts errors to a `[bridge.ts fatal]` `<pre>` and to the output channel. If those fired, term is never constructed and nothing about selection matters. Look at the Sandy output channel for any `[bridge]` error lines.

## Repo conventions to know

- Working dir: `~/dev/sandy-ui`. Branch: `main`. Commit/push directly to main is the workflow (no feature branches).
- After any change: `npm run install-vsix` rebuilds + reinstalls into your real VSCode (not the dev host). Then Cmd+Shift+P → "Developer: Reload Window".
- Webview TS sources are under `media/{terminal,settings}/src/*.ts`, bundled into `media/{terminal,settings}/dist/*.js` by `npm run build:webviews`. Both run as part of `npm run compile`.
- xterm.js is vendored at `media/terminal/vendor/xterm.js`, copied from node_modules by `scripts/copy-xterm.js`.
- See `CLAUDE.md` for full conventions, especially the "Two-process pattern" and "OSC handling chain" sections — they explain how host and webview communicate.

Report back with: which of steps 1–4 the fix landed in, what the diagnostic line showed (if added), and the commit hash of the fix.
