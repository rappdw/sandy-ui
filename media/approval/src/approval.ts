// Webview side of the pre-flight approval modal — the security gate that
// shows raw KEY=VALUE content before a privileged launch. The load-bearing
// property is VERBATIM rendering: everything lands via textContent (never
// innerHTML), so `<script>`, `&`, quotes, and whitespace in a hostile
// workspace config cannot be interpreted or collapsed.
//
// Mirrors the host-side contract in src/approval/webviewModal.ts. Kept
// structural (no shared file) — host is Node-targeted, this is browser-
// targeted; duplication is cheap, coupling is not.

export {}; // mark as module so local types don't leak into global scope

type FromHost = { type: "render"; header: string; subtext: string; body: string };
type ToHost   = { type: "ready" } | { type: "decision"; value: "approve" | "reject" };

(() => {
  "use strict";
  const vscode = acquireVsCodeApi();

  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} missing from approval webview HTML`);
    return el;
  };

  const post = (m: ToHost) => vscode.postMessage(m);

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as FromHost;
    if (m.type !== "render") return;
    // textContent (NOT innerHTML) — guarantees no HTML interpretation.
    $("header").textContent  = m.header;
    $("subtext").textContent = m.subtext;
    $("body").textContent    = m.body;
  });

  $("approve").addEventListener("click", () => post({ type: "decision", value: "approve" }));
  $("reject").addEventListener("click",  () => post({ type: "decision", value: "reject" }));

  post({ type: "ready" });
})();
