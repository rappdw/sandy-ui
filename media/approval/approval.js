(() => {
  "use strict";
  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type !== "render") return;
    // textContent (NOT innerHTML) — guarantees no HTML interpretation.
    $("header").textContent  = m.header;
    $("subtext").textContent = m.subtext;
    $("body").textContent    = m.body;
  });

  $("approve").addEventListener("click", () => vscode.postMessage({ type: "decision", value: "approve" }));
  $("reject").addEventListener("click",  () => vscode.postMessage({ type: "decision", value: "reject" }));

  vscode.postMessage({ type: "ready" });
})();
