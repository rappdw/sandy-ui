// Compatibility-gate integration smoke (rappdw/sandy-ui#30). The actual
// gating logic (evaluateCompat/describeVerdict boundary cases) is exhaustively
// vitest-covered in test/schema-compat.test.ts — that's pure logic and needs
// no real extension host. What vitest CAN'T reach is activation itself:
// this suite drives the real extension against test/fixtures/fake-sandy with
// an incompatible version/schema and asserts the gate is genuinely
// NON-BLOCKING — the extension stays active and commands keep working —
// rather than asserting on the toast notification itself (not reachable
// from here; see daemon.test.ts's header comment on the same limitation).
//
// Same wrapper-script trick as daemon.test.ts: sandy.binaryPath points at a
// tiny generated wrapper that exports FAKE_SANDY_STATE before exec-ing the
// fixture, since buildCleanEnv() (src/terminal/pty.ts) would otherwise strip
// FAKE_SANDY_STATE from the spawned process's env.

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_ID = "rappdw.sandy-ui";
const repoRoot = path.join(__dirname, ".."); // out-integration/ -> repo root

async function setCfg(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

function writeWrapper(stateDir: string): string {
  const fixture = path.join(repoRoot, "test", "fixtures", "fake-sandy", "fake-sandy");
  const wrapperPath = path.join(stateDir, "fake-sandy-wrapper.sh");
  const script = `#!/bin/bash\nexport FAKE_SANDY_STATE="${stateDir}"\nexec "${fixture}" "$@"\n`;
  fs.writeFileSync(wrapperPath, script);
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

function writeKnob(stateDir: string, name: string, value: string): void {
  fs.mkdirSync(path.join(stateDir, "knobs"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "knobs", name), value);
}

describe("Compatibility gate (fake-sandy) — non-blocking activation", function () {
  this.timeout(30_000);

  let stateDir: string;
  let wrapperPath: string;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-compat-it-"));
    wrapperPath = writeWrapper(stateDir);
    await setCfg("sandy", "binaryPath", wrapperPath);
  });

  after(async () => {
    await setCfg("sandy", "binaryPath", "");
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("stays active and responsive against a pre-1.0.0 (too-old) sandy", async () => {
    writeKnob(stateDir, "version", "sandy 0.9.0");

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, "extension should remain active with an incompatible sandy version");
    // The gate must not disable commands — sandy.state.refresh (which itself
    // shells out to the same fixture) should still complete without throwing.
    await assert.doesNotReject(() => Promise.resolve(vscode.commands.executeCommand("sandy.state.refresh")));
  });

  it("stays active and responsive against a schema_version beyond the supported major (schema 3)", async () => {
    writeKnob(stateDir, "version", "sandy 2.0.0");
    writeKnob(stateDir, "schema-version", "3");

    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext?.isActive, "extension should remain active with an unsupported schema_version");
    await assert.doesNotReject(() => Promise.resolve(vscode.commands.executeCommand("sandy.state.refresh")));
  });
});
