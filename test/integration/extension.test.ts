// Integration tests — run inside a real downloaded VSCode via @vscode/test-cli.
// These can't reach inside webviews directly (CSP isolation) but they CAN
// assert: the extension activates, contributed commands are registered,
// commands invoke without throwing, and webview panels open as a result.
//
// Anything below the host/webview boundary (xterm.js, OSC parsing, form
// rendering) is unit-testable via vitest in test/*.test.ts — keep this
// suite focused on the host-side surface that vitest can't reach.

import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "rappdw.sandy-ui";

// Every command sandy-ui contributes via package.json. If this list drifts
// out of sync with package.json, the assertion catches it.
const EXPECTED_COMMANDS = [
  "sandy.launch",
  "sandy.approval.test",
  "sandy.settings.open",
  "sandy.state.refresh",
  "sandy.statusbar.click",
  "sandy.tree.launch",
  "sandy.tree.openWorkspace",
  "sandy.tree.openWorkspaceNewWin",
  "sandy.tree.revealSandbox",
  "sandy.tree.copyWorkspacePath",
  "sandy.tree.detach",
  "sandy.tree.stop",
  "sandy.tree.removeLock",
  "sandy.tree.deleteSandbox",
];

describe("Extension activation", () => {
  it("extension is present", () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `extension ${EXTENSION_ID} not found — is it installed in the test runtime?`);
  });

  it("extension activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, "extension not present");
    await ext.activate();
    assert.ok(ext.isActive, "extension failed to activate");
  });

  it("every contributed command is registered after activation", async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    const all = await vscode.commands.getCommands(/* filterInternal */ true);
    const missing = EXPECTED_COMMANDS.filter(c => !all.includes(c));
    assert.deepEqual(missing, [], `commands missing from registry: ${missing.join(", ")}`);
  });
});

describe("Configuration contributions", () => {
  it("sandy.binaryPath is contributed and reads as a string with default ''", () => {
    const cfg = vscode.workspace.getConfiguration("sandy");
    const v = cfg.get<string>("binaryPath");
    assert.strictEqual(typeof v, "string");
    assert.strictEqual(v, "");  // default
  });

  it("sandy.launch.* booleans are contributed with expected defaults", () => {
    const cfg = vscode.workspace.getConfiguration("sandy.launch");
    assert.strictEqual(cfg.get<boolean>("closeBottomPanel"),  true);
    assert.strictEqual(cfg.get<boolean>("closeAuxiliaryBar"), true);
    assert.strictEqual(cfg.get<boolean>("closeSidebar"),      false);
  });
});

describe("Webview commands open panels", () => {
  // Webview internals (CSP-sandboxed) aren't reachable from the test runtime,
  // but we can verify that invoking the command results in a webview panel
  // appearing in the editor area. Uses tabGroups to count panels before/after.

  function countWebviewTabs(): number {
    return vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputWebview)
      .length;
  }

  async function closeAllWebviews(): Promise<void> {
    const tabs = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputWebview);
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }

  beforeEach(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    await closeAllWebviews();
  });
  afterEach(async () => { await closeAllWebviews(); });

  it("sandy.settings.open creates a webview panel", async () => {
    const before = countWebviewTabs();
    await vscode.commands.executeCommand("sandy.settings.open");
    // Tab registration in tabGroups is async with no event we can await
    // here — poll instead of a fixed sleep (a 200ms sleep flaked on the
    // macOS CI runner: run 29518400642 failed, identical rerun passed).
    const deadline = Date.now() + 5_000;
    let after = countWebviewTabs();
    while (after <= before && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
      after = countWebviewTabs();
    }
    assert.ok(after > before, `expected a new webview panel within 5s; before=${before} after=${after}`);
  });
});
