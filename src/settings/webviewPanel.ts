import * as vscode from "vscode";
import * as fs from "fs";
import {
  Schema, Scope,
  readSandyKv, readScopeView, saveScope,
  HOME_CONFIG, HOME_SECRETS,
  workspaceConfigPath, workspaceSecretsPath,
  configPathFor, secretsPathFor,
} from "./configIO";
// Schema source: invoke `sandy --print-schema` (cached by sandy version);
// fall back to the bundled mock if sandy isn't on PATH or the invocation
// fails. The mock stays bundled-via-resolveJsonModule so it ships with the
// vsix for the offline-fallback path.
import schemaMock from "../mocks/schema.json";
import { getCachedSchema } from "../schema/cache";

// Settings Save was OFF in 0.8.3 (rappdw/sandy-ui#53): the save path routed 16
// non-secret privileged keys (SANDY_ALLOW_NO_ISOLATION, …) into .secrets, where
// the form could neither show nor clear them. Fixed by routing on type alone
// and migrating misplaced keys (configIO.saveScope). The switch stays as a kill
// switch: while false the host refuses EVERY save, whatever the webview sends,
// and the webview renders read-only.
const SETTINGS_SAVE_ENABLED = true;

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
        const resolution = await schemaPromise;
        const schema = resolution.schema;
        const describe = (label: string, file: string | undefined) => {
          const n = file ? Object.keys(readSandyKv(file)).length : 0;
          log(`  ${label} = ${file ?? "(none)"} (exists=${file ? fs.existsSync(file) : false}, ${n} keys)`);
        };
        log(`ready`);
        describe("home   config ", HOME_CONFIG);
        describe("home   secrets", HOME_SECRETS);
        describe("ws     config ", wsConfigPath);
        describe("ws     secrets", wsSecretsPath);

        const scopeMessage = (scope: Scope) => {
          const view = readScopeView(scope, ws, schema);
          if (view.misplaced.length) {
            log(`  ${scope}: non-secret keys stored in .secrets (moved to config when saved): ${view.misplaced.join(",")}`);
          }
          const configPath = configPathFor(scope, ws);
          return { configPath, secretsPath: secretsPathFor(scope, ws), exists: fs.existsSync(configPath), ...view };
        };
        panel.webview.postMessage({
          type: "schema",
          readOnly: !SETTINGS_SAVE_ENABLED,
          schema,
          source: { kind: resolution.source, error: resolution.error },
          scopes: {
            home:      scopeMessage("home"),
            workspace: ws ? scopeMessage("workspace") : null,
          },
        });
        break;
      }
      case "save": {
        if (!SETTINGS_SAVE_ENABLED) {
          log(`save refused (scope=${m.scope}): saving from the Settings panel is disabled in this build — rappdw/sandy-ui#53`);
          vscode.window.showWarningMessage("Sandy: saving from the Settings panel is turned off in this version. Edit the config file directly for now.");
          panel.webview.postMessage({ type: "saveFailed", scope: m.scope });
          break;
        }
        const scope = m.scope as Scope;
        const incoming = m.values as Record<string, string>;
        const clearSecrets = (m.clearSecrets as string[] | undefined) ?? [];
        log(`save (scope=${scope}) — incoming keys: ${Object.keys(incoming).join(",")}` +
          (clearSecrets.length ? `, clearSecrets: ${clearSecrets.join(",")}` : ""));
        try {
          if (scope === "workspace" && !ws) {
            throw new Error("No workspace folder open — cannot save to workspace scope.");
          }
          const schema = (await schemaPromise).schema;
          const result = saveScope(scope, ws, schema, incoming, clearSecrets);
          if (result.refusedClears.length) log(`REFUSED clearSecrets (not secret-type schema keys): ${result.refusedClears.join(",")}`);
          if (result.refusedKeys.length) log(`REFUSED keys (not in the schema, or value has a line break): ${result.refusedKeys.join(",")}`);
          const configTarget  = configPathFor(scope, ws);
          const secretsTarget = secretsPathFor(scope, ws);
          const view = readScopeView(scope, ws, schema);
          // Read-back verification logs key names + status ONLY — never the
          // values (review finding S1). It checks what sandy will now read,
          // .secrets included, so a stale .secrets copy shows up as a MISMATCH.
          for (const [k, v] of Object.entries(incoming)) {
            if (result.refusedKeys.includes(k)) continue;
            if (k in view.secretsPresent || schema.fields.find(f => f.key === k)?.type === "secret") {
              log(view.secretsPresent[k] ? `ok ${k} (secret set)` : `MISMATCH ${k}: secret not present after save`);
              continue;
            }
            const got = view.values[k];
            if (v === "") log(got === undefined ? `ok ${k} (cleared)` : `MISMATCH ${k}: expected cleared, still set`);
            else if (got !== v) log(`MISMATCH ${k}: read-back differs (values not logged; len wrote=${v.length} read=${got?.length ?? 0})`);
            else log(`ok ${k}`);
          }
          for (const k of clearSecrets) {
            if (result.refusedClears.includes(k)) continue;
            log(view.secretsPresent[k] ? `MISMATCH ${k}: expected cleared, still present` : `ok ${k} (secret cleared)`);
          }
          const written = [result.wroteConfig && configTarget, result.wroteSecrets && secretsTarget].filter(Boolean);
          if (written.length) vscode.window.showInformationMessage(`Saved to ${written.join(" and ")}`);
          else vscode.window.showInformationMessage("Sandy: no changes to save.");
          // Send back the files as they now are: the form's baseline must
          // track the file, or an edit that is later reverted compares as
          // unchanged and is never saved. Same shape as the initial message:
          // non-secret values, secrets as presence flags only.
          panel.webview.postMessage({ type: "saved", scope, ...view });
        } catch (e: any) {
          log(`save failed: ${e?.message ?? e}`);
          vscode.window.showErrorMessage(`Save failed: ${e?.message ?? e}`);
          panel.webview.postMessage({ type: "saveFailed", scope: m.scope });
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
  <p id="schema-warn" class="warn" hidden></p>
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
