import * as vscode from "vscode";
import * as fs from "fs";
import {
  Schema, Scope,
  readKv, saveScope,
  HOME_CONFIG, HOME_SECRETS,
  workspaceConfigPath, workspaceSecretsPath,
  secretsPathFor,
} from "./configIO";
// Schema mock is bundled at compile time via resolveJsonModule. No runtime
// file lookup — works whether running from src/ during F5 dev or from the
// installed vsix where src/ doesn't exist. Will be replaced by a `sandy
// --print-schema` invocation in 0.1.0.
import schemaMock from "../mocks/schema.json";

const out = vscode.window.createOutputChannel("Sandy Settings");
const log = (msg: string) => out.appendLine(`[${new Date().toISOString()}] ${msg}`);

export function openSettingsPanel(ctx: vscode.ExtensionContext) {
  const panel = vscode.window.createWebviewPanel(
    "sandy.settings",
    "Sandy Settings",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false, // exercise getState/setState on purpose
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, "media")],
    }
  );

  const mediaUri = (sub: string) =>
    panel.webview.asWebviewUri(vscode.Uri.joinPath(ctx.extensionUri, "media", "settings", sub));
  panel.webview.html = renderHtml({
    cspSource: panel.webview.cspSource,
    js:        mediaUri("dist/settings.js"),
    css:       mediaUri("settings.css"),
  });

  const schema = schemaMock as Schema;
  out.show(true);

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const wsConfigPath  = ws ? workspaceConfigPath(ws)  : undefined;
  const wsSecretsPath = ws ? workspaceSecretsPath(ws) : undefined;

  panel.webview.onDidReceiveMessage(async (m: { type: string; [k: string]: any }) => {
    switch (m.type) {
      case "log": {
        log(`[webview ${m.level}] ${m.msg}`);
        break;
      }
      case "ready": {
        const homeConfig    = readKv(HOME_CONFIG);
        const homeSecrets   = readKv(HOME_SECRETS);
        const wsConfig      = wsConfigPath  ? readKv(wsConfigPath)  : {};
        const wsSecrets     = wsSecretsPath ? readKv(wsSecretsPath) : {};

        const presence = (kv: Record<string, string>) => {
          const out: Record<string, boolean> = {};
          for (const k of Object.keys(kv)) out[k] = true;
          return out;
        };

        log(`ready`);
        log(`  home   config = ${HOME_CONFIG}    (exists=${fs.existsSync(HOME_CONFIG)},    ${Object.keys(homeConfig).length} keys)`);
        log(`  home   secrets= ${HOME_SECRETS}   (exists=${fs.existsSync(HOME_SECRETS)},   ${Object.keys(homeSecrets).length} keys)`);
        log(`  ws     config = ${wsConfigPath  ?? "(none)"} (exists=${wsConfigPath  ? fs.existsSync(wsConfigPath)  : false}, ${Object.keys(wsConfig).length} keys)`);
        log(`  ws     secrets= ${wsSecretsPath ?? "(none)"} (exists=${wsSecretsPath ? fs.existsSync(wsSecretsPath) : false}, ${Object.keys(wsSecrets).length} keys)`);

        panel.webview.postMessage({
          type: "schema",
          schema,
          scopes: {
            home: {
              configPath:     HOME_CONFIG,
              secretsPath:    HOME_SECRETS,
              values:         homeConfig,
              exists:         fs.existsSync(HOME_CONFIG),
              secretsPresent: presence(homeSecrets),
            },
            workspace: wsConfigPath ? {
              configPath:     wsConfigPath,
              secretsPath:    wsSecretsPath,
              values:         wsConfig,
              exists:         fs.existsSync(wsConfigPath),
              secretsPresent: presence(wsSecrets),
            } : null,
          },
        });
        break;
      }
      case "save": {
        const scope = m.scope as Scope;
        const incoming = m.values as Record<string, string>;
        log(`save (scope=${scope}) — incoming keys: ${Object.keys(incoming).join(",")}`);
        try {
          if (scope === "workspace" && !ws) {
            throw new Error("No workspace folder open — cannot save to workspace scope.");
          }
          saveScope(scope, ws, schema, incoming);
          const configTarget  = scope === "home" ? HOME_CONFIG  : wsConfigPath!;
          const secretsTarget = secretsPathFor(scope, ws);
          const verifyConfig  = readKv(configTarget);
          const verifySecrets = readKv(secretsTarget);
          for (const [k, v] of Object.entries(incoming)) {
            const got = verifyConfig[k] ?? verifySecrets[k];
            if (got !== v) log(`MISMATCH ${k}: wrote=${JSON.stringify(v)} read-back=${JSON.stringify(got)}`);
            else log(`ok ${k}=${JSON.stringify(got)} (in ${verifyConfig[k] != null ? "config" : "secrets"})`);
          }
          const wroteSecrets = Object.keys(incoming).some(k => verifySecrets[k] != null);
          vscode.window.showInformationMessage(`Saved to ${configTarget}${wroteSecrets ? ` and ${secretsTarget}` : ""}`);
          panel.webview.postMessage({ type: "saved", scope });
        } catch (e: any) {
          log(`save failed: ${e?.message ?? e}`);
          vscode.window.showErrorMessage(`Save failed: ${e?.message ?? e}`);
        }
        break;
      }
    }
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
  <h1>Sandy Settings</h1>
  <div id="tabs" role="tablist">
    <button id="tab-workspace" class="tab active" role="tab">Project</button>
    <button id="tab-home"      class="tab"        role="tab">Global</button>
  </div>
  <div id="scope-info">
    <p class="hint" id="scope-hint"></p>
    <p class="warn" id="scope-warn" hidden></p>
  </div>
  <form id="form"></form>
  <div id="actions">
    <button id="revert" type="button">Revert</button>
    <button id="save"   type="button" class="primary">Save</button>
  </div>
  <script src="${uris.js}"></script>
</body>
</html>`;
}
