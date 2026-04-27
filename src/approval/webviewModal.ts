import * as vscode from "vscode";
import { HEADER, SUBTEXT, HOSTILE_KEYVALUES } from "./sample";

// Webview-based fallback: full control over text rendering, no risk of the
// renderer collapsing whitespace or HTML-encoding special chars (we use
// textContent assignment in the webview JS, never innerHTML).
export async function openApprovalWebview(ctx: vscode.ExtensionContext): Promise<"approve" | "reject" | undefined> {
  const panel = vscode.window.createWebviewPanel(
    "sandy.approval",
    "Sandy: approval required",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    }
  );

  const mediaUri = (sub: string) =>
    panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "approval", sub));
  panel.webview.html = renderHtml({
    cspSource: panel.webview.cspSource,
    js:        mediaUri("approval.js"),
    css:       mediaUri("approval.css"),
  });

  return await new Promise<"approve" | "reject" | undefined>((resolve) => {
    let resolved = false;
    panel.onDidDispose(() => {
      if (!resolved) { resolved = true; resolve(undefined); }
    });
    panel.webview.onDidReceiveMessage((m: { type: "ready" } | { type: "decision"; value: "approve" | "reject" }) => {
      if (m.type === "ready") {
        // Send raw payload AS DATA (not HTML) so the webview can render it
        // via textContent — no encoding risk.
        panel.webview.postMessage({ type: "render", header: HEADER, subtext: SUBTEXT, body: HOSTILE_KEYVALUES });
      } else if (m.type === "decision") {
        if (!resolved) { resolved = true; resolve(m.value); }
        panel.dispose();
      }
    });
  });
}

function renderHtml(uris: { cspSource: string; js: vscode.Uri; css: vscode.Uri }): string {
  const csp = `default-src 'none'; script-src ${uris.cspSource}; style-src ${uris.cspSource} 'unsafe-inline';`;
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${uris.css}" />
</head>
<body>
  <h1 id="header"></h1>
  <p id="subtext"></p>
  <pre id="body"></pre>
  <div id="actions">
    <button id="reject" class="reject">Reject</button>
    <button id="approve" class="approve">Approve</button>
  </div>
  <script src="${uris.js}"></script>
</body>
</html>`;
}
