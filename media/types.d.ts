// Type declarations for globals provided by VSCode webview runtime + the
// xterm.js script tags loaded from media/terminal/vendor/.
//
// These are declared (not imported) because the webview runtime does NOT
// support ES module imports for these — they're loaded as <script src=...>
// and exposed on `window`. esbuild emits bare identifier references which
// resolve to those globals at runtime.

import type { Terminal as XtermTerminal, ITerminalOptions, IDisposable } from "@xterm/xterm";
import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { WebLinksAddon as XtermWebLinksAddon } from "@xterm/addon-web-links";

declare global {
  // xterm.js loads as a UMD bundle, exposing window.Terminal directly.
  const Terminal: typeof XtermTerminal;

  // The fit addon's UMD bundle exposes window.FitAddon as a namespace
  // containing the FitAddon class.
  const FitAddon: { FitAddon: typeof XtermFitAddon };

  // Same for web-links.
  const WebLinksAddon: { WebLinksAddon: typeof XtermWebLinksAddon };

  // VSCode webview API. Returned object is opaque except for the documented
  // postMessage / getState / setState surface.
  function acquireVsCodeApi(): VSCodeApi;

  // Re-export the type so call sites don't need to import it.
  type IDisposable = IDisposable;
  type ITerminalOptions = ITerminalOptions;
}

export interface VSCodeApi {
  postMessage(message: unknown): void;
  getState<T = unknown>(): T | undefined;
  setState<T>(state: T): void;
}

// Make this file a module so `declare global` is hoisted properly.
export {};
