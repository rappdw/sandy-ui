// Daemon-lifecycle integration coverage (rappdw/sandy-ui#27) — the largest
// item in 0.7.0 and the reason 0.7 precedes 0.8: daemon flows had zero
// integration coverage before this, validated only by sandy's own
// acceptance harness plus manual soak. Drives the REAL extension host
// (activation, commands, webview panels, node-pty spawns) against
// test/fixtures/fake-sandy instead of a real sandy + Docker.
//
// Same conventions as extension.test.ts: mocha bdd, node:assert/strict.
// Can't reach inside the webview (CSP isolation) — assertions live at the
// host/tab/filesystem boundary: tab presence, sandy.* command outcomes, and
// the fixture's own on-disk session state (which IS the durable truth for a
// daemon session, per the frozen contract — see src/daemon/contract.ts and
// the CLAUDE.md "Architecture" section on the daemon backend).
//
// ENV-WHITELIST WRAPPER TRICK — read this before touching FAKE_SANDY_STATE:
// This test runs INSIDE the extension host process, so mutating
// process.env here DOES propagate to ptys the extension spawns... except
// buildCleanEnv() (src/terminal/pty.ts) whitelists only HOME/USER/PATH/
// LANG/TERM/SHELL/SSH_AUTH_SOCK plus LC_*/SANDY_* prefixes — FAKE_SANDY_STATE
// matches none of those, so it would be silently stripped from the spawned
// pty's env no matter how we set it on this process. Setting
// `sandy.binaryPath` straight to the fixture path would therefore spawn a
// fake-sandy with no FAKE_SANDY_STATE, and every state/mutating command
// would refuse (by design — see the fixture's own header comment). The fix:
// point `sandy.binaryPath` at a tiny WRAPPER script (generated per-suite
// into the tmp state dir) that exports FAKE_SANDY_STATE itself before
// exec-ing the real fixture — the exported var lives in the wrapper's own
// process image, so buildCleanEnv's whitelist never gets a say. This also
// exercises real sandy.binaryPath resolution end-to-end (not a shortcut).

import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION_ID = "rappdw.sandy-ui";
const repoRoot = path.join(__dirname, ".."); // out-integration/ -> repo root

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll helper — every wait in this suite goes through this, never a bare
// sleep, so failures show up as a clear timeout instead of a flaky race.
async function until(predicate: () => boolean, timeoutMs = 10_000, stepMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(stepMs);
  }
  throw new Error(`until: timed out after ${timeoutMs}ms`);
}

async function setCfg(section: string, key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
}

// Sandy's own basename sanitization (tr -cd 'a-zA-Z0-9._-', "project" when
// empty) plus the fixture's fixed "-fake0001" suffix — see the fixture's
// session_name_for(). Lets tests predict the session/sandbox name without
// shelling out.
function predictedSandboxName(workspaceFsPath: string): string {
  const base = path.basename(workspaceFsPath).replace(/[^a-zA-Z0-9._-]/g, "") || "project";
  return `${base}-fake0001`;
}

function writeWrapper(stateDir: string): string {
  const fixture = path.join(repoRoot, "test", "fixtures", "fake-sandy", "fake-sandy");
  const wrapperPath = path.join(stateDir, "fake-sandy-wrapper.sh");
  const script = `#!/bin/bash\nexport FAKE_SANDY_STATE="${stateDir}"\nexec "${fixture}" "$@"\n`;
  fs.writeFileSync(wrapperPath, script);
  fs.chmodSync(wrapperPath, 0o755);
  return wrapperPath;
}

describe("Daemon lifecycle (fake-sandy)", function () {
  // Real node-pty spawns + a 0.2s attach poll loop in the fixture — give
  // each test more headroom than the suite default.
  this.timeout(30_000);

  let stateDir: string;
  let wrapperPath: string;
  let ws: string;
  let sandboxName: string;

  function logPath(): string { return path.join(stateDir, "log"); }
  // Preserves genuine empty lines (a bare fake-sandy invocation with no argv
  // logs an empty line — see the fixture's log_invocation) while dropping
  // only the single trailing artifact `String.split("\n")` produces because
  // every log line ends with its own "\n". Do NOT `.filter(Boolean)` here.
  function invocations(): string[] {
    if (!fs.existsSync(logPath())) return [];
    const lines = fs.readFileSync(logPath(), "utf8").split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }

  function sessionPath(name: string): string {
    return path.join(stateDir, "sessions", `${name}.json`);
  }
  function sessionExists(name: string): boolean {
    return fs.existsSync(sessionPath(name));
  }
  function readSession(name: string): { workspace_path: string; started_at: string; attached_clients: number } {
    return JSON.parse(fs.readFileSync(sessionPath(name), "utf8"));
  }

  function sandyTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .filter(t => t.input instanceof vscode.TabInputWebview && t.label.startsWith("Sandy"));
  }
  async function closeSandyTabs(): Promise<void> {
    const tabs = sandyTabs();
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs);
  }

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();

    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sandy-ui-daemon-it-"));
    wrapperPath = writeWrapper(stateDir);

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "expected a workspace folder (test/fixtures/empty-workspace) to be open");
    ws = folder!.uri.fsPath;
    sandboxName = predictedSandboxName(ws);

    // sandy.binaryPath -> wrapper exercises real resolveSandyBinary()
    // resolution; persistSessions on is required for the daemon path;
    // closeBottomPanel off avoids the layout churn of closing/reopening the
    // output-channel-holding panel on every launch in this suite.
    await setCfg("sandy", "binaryPath", wrapperPath);
    await setCfg("sandy", "persistSessions", true);
    await setCfg("sandy.launch", "closeBottomPanel", false);
  });

  afterEach(async () => {
    // Restore whatever an individual test overrode, even on failure — tests
    // 5 and 6 flip these; tests 1-4 don't touch them (no-op restore).
    await setCfg("sandy", "launchCommand", "");
    await setCfg("sandy", "persistSessions", true);
  });

  after(async () => {
    await closeSandyTabs();
    await setCfg("sandy", "binaryPath", "");
    await setCfg("sandy", "persistSessions", true);
    await setCfg("sandy.launch", "closeBottomPanel", true);
    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Tests 1-4 are a deliberately continuous narrative against ONE daemon
  // session for `ws` (launch -> detach -> reattach -> stop) — each depends
  // on state the previous test left behind, mirroring how a real user
  // session actually flows. Tests 5-6 are independent (legacy path) and
  // each cleans up fully before returning.

  it("1. two-phase daemon launch: --start then --attach, a Sandy tab opens, attached_clients=1", async () => {
    await vscode.commands.executeCommand("sandy.launch");

    await until(() => {
      const lines = invocations();
      const startIdx = lines.indexOf(`--start --workspace ${ws}`);
      const attachIdx = lines.indexOf(`--attach --workspace ${ws}`);
      return startIdx !== -1 && attachIdx !== -1 && attachIdx > startIdx;
    }, 15_000);

    assert.ok(sandyTabs().length > 0, "expected a Sandy-labeled tab to be open");

    await until(() => sessionExists(sandboxName) && readSession(sandboxName).attached_clients === 1, 10_000);
  });

  it("2. closing the tab detaches — session persists on the fixture, no --stop logged", async () => {
    assert.equal(readSession(sandboxName).attached_clients, 1, "precondition: attached from test 1");

    await closeSandyTabs();

    await until(() => sessionExists(sandboxName) && readSession(sandboxName).attached_clients === 0, 10_000);
    assert.ok(sessionExists(sandboxName), "session should still exist after a plain detach (daemon sessions persist)");
    assert.ok(
      !invocations().some(l => l.startsWith("--stop")),
      "tab close on a daemon session must detach, never --stop"
    );
  });

  it("3. relaunching reattaches: a second --start (idempotent) + --attach, attached_clients back to 1", async () => {
    const marker = invocations().length;

    await vscode.commands.executeCommand("sandy.launch");

    await until(() => {
      const post = invocations().slice(marker);
      const startIdx = post.indexOf(`--start --workspace ${ws}`);
      const attachIdx = post.indexOf(`--attach --workspace ${ws}`);
      return startIdx !== -1 && attachIdx !== -1 && attachIdx > startIdx;
    }, 15_000);

    await until(() => sessionExists(sandboxName) && readSession(sandboxName).attached_clients === 1, 10_000);
    assert.ok(sandyTabs().length > 0, "expected the re-attached Sandy tab to be open");
  });

  it("4. explicit stop tears the daemon session down (fallback path — no local supervisor session)", async () => {
    // Detach again first so the supervisor holds no local client for this
    // workspace when we call Stop — pins sandy.tree.stop's daemon-fallback
    // branch (a direct `sandy --stop` execFile) rather than the
    // supervisor.stop() branch exercised implicitly while attached.
    await closeSandyTabs();
    await until(() => sessionExists(sandboxName) && readSession(sandboxName).attached_clients === 0, 10_000);

    // The poller is cadence-gated (tree-view visibility + window focus) and
    // may not have observed this session yet; force a refresh so
    // daemonInfoFor() has running_containers to match sandboxName against.
    await vscode.commands.executeCommand("sandy.state.refresh");

    const marker = invocations().length;
    await vscode.commands.executeCommand("sandy.tree.stop", { sandbox: { name: sandboxName, workspace_path: ws } });

    await until(() => invocations().slice(marker).includes(`--stop --workspace ${ws}`), 10_000);
    await until(() => !sessionExists(sandboxName), 10_000);
  });

  it("5. sandy.launchCommand precedence (#24): forces the legacy bare path, no daemon calls", async () => {
    const marker = invocations().length;
    await setCfg("sandy", "launchCommand", wrapperPath);

    await vscode.commands.executeCommand("sandy.launch");
    // A bare fake-sandy invocation (no argv at all) logs an empty line.
    await until(() => invocations().slice(marker).includes(""), 10_000);

    const post = invocations().slice(marker);
    assert.ok(
      !post.some(l => l.startsWith("--start")),
      `launchCommand override must bypass the daemon path entirely; log had: ${JSON.stringify(post)}`
    );

    // Deterministic teardown before the next test: awaited stop guarantees
    // the legacy pty has exited (no session -> graceful no-op) rather than
    // racing a fire-and-forget tab-close dispose handler.
    await vscode.commands.executeCommand("sandy.tree.stop", { sandbox: { name: sandboxName, workspace_path: ws } });
    await closeSandyTabs();
  });

  it("6. persistSessions off: legacy bare path, no --start", async () => {
    const marker = invocations().length;
    await setCfg("sandy", "persistSessions", false);

    await vscode.commands.executeCommand("sandy.launch");
    await until(() => invocations().slice(marker).includes(""), 10_000);

    const post = invocations().slice(marker);
    assert.ok(
      !post.some(l => l.startsWith("--start")),
      `persistSessions=false must use the legacy path; log had: ${JSON.stringify(post)}`
    );

    await vscode.commands.executeCommand("sandy.tree.stop", { sandbox: { name: sandboxName, workspace_path: ws } });
    await closeSandyTabs();
  });

  it("7. restoreSessionsOnStartup default OFF: a persisted session present does not auto-open a tab", async () => {
    // maybeRestoreSession (rappdw/sandy-ui#32) only runs once, at extension
    // activation — which already happened in `before()`, long before this
    // test exists. Re-triggering activation isn't available from a single
    // extension-host test (no API to deactivate + reactivate an installed
    // extension mid-suite). So this is a light architectural sanity check,
    // not a re-exercise of the gate itself: confirm the setting's registered
    // default is really false (guards against an accidental default-on
    // regression), and confirm no Sandy tab spontaneously reopens for this
    // workspace while a persisted session exists and the setting is off.
    // The real behavioral coverage for the join/gate lives in the pure
    // persistedSessionForWorkspace unit tests (test/state-badge.test.ts).
    const inspected = vscode.workspace.getConfiguration("sandy").inspect<boolean>("restoreSessionsOnStartup");
    assert.equal(inspected?.defaultValue, false, "sandy.restoreSessionsOnStartup must default to false");

    // Establish a persisted daemon session (launch, then detach) so there's
    // something an auto-restore COULD attach to if it were wrongly firing.
    await vscode.commands.executeCommand("sandy.launch");
    await until(() => {
      const lines = invocations();
      return lines.includes(`--start --workspace ${ws}`) && lines.includes(`--attach --workspace ${ws}`);
    }, 15_000);
    await until(() => sessionExists(sandboxName) && readSession(sandboxName).attached_clients === 1, 10_000);
    await closeSandyTabs();
    await until(() => sessionExists(sandboxName) && readSession(sandboxName).attached_clients === 0, 10_000);

    await sleep(2_000);
    assert.equal(sandyTabs().length, 0, "no Sandy tab should auto-open when restoreSessionsOnStartup is off (default)");

    // Teardown: stop the persisted session so it doesn't leak into other tests.
    await vscode.commands.executeCommand("sandy.state.refresh");
    await vscode.commands.executeCommand("sandy.tree.stop", { sandbox: { name: sandboxName, workspace_path: ws } });
    await until(() => !sessionExists(sandboxName), 10_000);
  });
});
