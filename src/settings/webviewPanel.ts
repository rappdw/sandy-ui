import * as vscode from "vscode";
import * as fs from "fs";
import {
  Schema, Scope,
  readKv, saveScope,
  HOME_CONFIG, HOME_SECRETS,
  workspaceConfigPath, workspaceSecretsPath,
  secretsPathFor,
} from "./configIO";
// Schema source: invoke `sandy --print-schema` (cached by sandy version);
// fall back to the bundled mock if sandy isn't on PATH or the invocation
// fails. The mock stays bundled-via-resolveJsonModule so it ships with the
// vsix for the offline-fallback path.
import schemaMock from "../mocks/schema.json";
import { getCachedSchema } from "../schema/cache";

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

  // Kicked off immediately, awaited in the message handlers — never blocks
  // the extension host (getCachedSchema shells out to sandy; the sync
  // version froze the host up to ~15s when sandy/docker wedged).
  const schemaPromise = getCachedSchema(ctx.globalStorageUri.fsPath, schemaMock as Schema);
  void schemaPromise.then((resolution) => {
    log(`schema source=${resolution.source}` + (resolution.sandy_version ? ` (sandy ${resolution.sandy_version})` : ""));
    if (resolution.error) log(`schema fallback reason: ${resolution.error}`);
  });
  // Auto-pop the output channel only if the user keeps the bottom panel open
  // — same rationale as openTerminalPanel. Don't fight the maximize-editor-
  // space setting.
  if (!vscode.workspace.getConfiguration("sandy.launch").get<boolean>("closeBottomPanel", true)) {
    out.show(true);
  }

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
        const schema = (await schemaPromise).schema;
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
          const schema = (await schemaPromise).schema;
          saveScope(scope, ws, schema, incoming);
          const configTarget  = scope === "home" ? HOME_CONFIG  : wsConfigPath!;
          const secretsTarget = secretsPathFor(scope, ws);
          const verifyConfig  = readKv(configTarget);
          const verifySecrets = readKv(secretsTarget);
          // Read-back verification logs key names + status ONLY — never the
          // values. The old form printed plaintext values (including secrets)
          // to this output channel (review finding S1). "" incoming means the
          // key was cleared, so verify absence rather than equality.
          for (const [k, v] of Object.entries(incoming)) {
            const got = verifyConfig[k] ?? verifySecrets[k];
            const where = verifyConfig[k] != null ? "config" : verifySecrets[k] != null ? "secrets" : "absent";
            if (v === "") {
              if (got === undefined) log(`ok ${k} (cleared)`);
              else log(`MISMATCH ${k}: expected cleared, still present in ${where}`);
            } else if (got !== v) {
              log(`MISMATCH ${k}: read-back differs (values not logged; len wrote=${v.length} read=${got?.length ?? 0})`);
            } else {
              log(`ok ${k} (${where})`);
            }
          }
          const wroteSecrets = Object.keys(incoming).some(k => incoming[k] !== "" && verifySecrets[k] != null);
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
