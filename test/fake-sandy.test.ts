// Contract-pins test/fixtures/fake-sandy against the REAL production parsing
// chain (parseSandySchema, hasDaemonCapability, formatAge) — not a re-
// implementation of what those functions expect. If the fixture's JSON
// shape ever drifts from what sandy actually emits, this suite (which runs
// everywhere, including this sandboxed container with no display) catches
// it long before the @vscode/test-electron daemon-lifecycle suite
// (test/integration/daemon.test.ts, CI-only) would.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { parseSandySchema } from "../src/schema/parse";
import { hasDaemonCapability } from "../src/daemon/contract";
import { formatAge } from "../src/state/badge";

const FIXTURE = path.join(__dirname, "fixtures", "fake-sandy", "fake-sandy");

// The fixture is a bash script and models sandy's POSIX-only daemon contract
// (sandy itself doesn't run on Windows; the spec defers Windows support), so
// this suite is skipped on win32 — where execFileSync of a shebang script
// can't work anyway. All other vitest suites remain platform-portable.
const describeUnix = describe.skipIf(process.platform === "win32");

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-sandy-state-"));
});
afterEach(() => {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function writeKnob(name: string, content = ""): void {
  const dir = path.join(stateDir, "knobs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

function run(args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(FIXTURE, args, {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
      encoding: "utf8",
    });
    return { stdout, code: 0 };
  } catch (e: any) {
    return { stdout: e.stdout?.toString() ?? "", code: typeof e.status === "number" ? e.status : -1 };
  }
}

function sessionPath(name: string): string {
  return path.join(stateDir, "sessions", `${name}.json`);
}
function sessionAttachedClients(name: string): number {
  return JSON.parse(fs.readFileSync(sessionPath(name), "utf8")).attached_clients;
}

// Polls until predicate is true or timeoutMs elapses (never a bare sleep).
async function until(predicate: () => boolean, timeoutMs = 5_000, stepMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error(`until: timed out after ${timeoutMs}ms`);
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

function waitForExitFull(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

function attachPidPath(name: string): string {
  return path.join(stateDir, "sessions", `${name}.attach.pid`);
}

describeUnix("fake-sandy: --print-schema", () => {
  it("parses via the real parseSandySchema and reports daemon capability", () => {
    const { stdout, code } = run(["--print-schema"]);
    expect(code).toBe(0);
    const raw = JSON.parse(stdout);
    expect(raw.cli_flags.some((f: any) => f.name === "--start")).toBe(true);
    expect(hasDaemonCapability(parseSandySchema(raw))).toBe(true);
  });

  it("knobs/no-daemon-flags omits daemon flags and capability flips to false", () => {
    writeKnob("no-daemon-flags");
    const { stdout } = run(["--print-schema"]);
    const raw = JSON.parse(stdout);
    expect(raw.cli_flags).toEqual([]);
    expect(hasDaemonCapability(parseSandySchema(raw))).toBe(false);
  });
});

describeUnix("fake-sandy: --version", () => {
  it("default output regex-extracts 1.1.0 (mirrors cache.ts's trySandyVersion regex)", () => {
    const { stdout, code } = run(["--version"]);
    expect(code).toBe(0);
    const m = stdout.match(/\b\d+\.\d+\.\d+(?:[\w.-]*)?\b/);
    expect(m?.[0]).toBe("1.1.0");
  });

  it("knobs/version overrides the output", () => {
    writeKnob("version", "sandy 9.9.9-custom");
    const { stdout } = run(["--version"]);
    expect(stdout.trim()).toBe("sandy 9.9.9-custom");
    const m = stdout.match(/\b\d+\.\d+\.\d+(?:[\w.-]*)?\b/);
    expect(m?.[0]).toBe("9.9.9-custom");
  });
});

describeUnix("fake-sandy: --start", () => {
  it("session appears in --print-state (daemon true, attached_clients 0, parseable started_at)", () => {
    expect(run(["--start", "--workspace", "/tmp/proj-one"]).code).toBe(0);
    const state = JSON.parse(run(["--print-state"]).stdout);
    expect(state.running_containers).toHaveLength(1);
    const c = state.running_containers[0];
    expect(c.sandbox).toBe("proj-one-fake0001");
    expect(c.daemon).toBe(true);
    expect(c.attached_clients).toBe(0);
    expect(formatAge(c.started_at)).toBeDefined();
  });

  it("is idempotent — a second start keeps exactly one session", () => {
    run(["--start", "--workspace", "/tmp/proj-two"]);
    run(["--start", "--workspace", "/tmp/proj-two"]);
    const state = JSON.parse(run(["--print-state"]).stdout);
    expect(state.running_containers).toHaveLength(1);
  });

  it("knobs/start-exit nonzero fails the start and records no session", () => {
    writeKnob("start-exit", "7");
    const { code } = run(["--start", "--workspace", "/tmp/proj-three"]);
    expect(code).toBe(7);
    const state = JSON.parse(run(["--print-state"]).stdout);
    expect(state.running_containers).toHaveLength(0);
  });
});

describeUnix("fake-sandy: --attach", () => {
  it("exits 4 when no session exists for the workspace", () => {
    expect(run(["--attach", "--workspace", "/tmp/never-started"]).code).toBe(4);
  });

  it("knobs/attach-exit is honored immediately", () => {
    run(["--start", "--workspace", "/tmp/proj-a"]);
    writeKnob("attach-exit", "5");
    expect(run(["--attach", "--workspace", "/tmp/proj-a"]).code).toBe(5);
  });

  it("blocks until a .detach control file appears, then exits 3 with attached_clients back to 0", async () => {
    run(["--start", "--workspace", "/tmp/proj-b"]);
    const name = "proj-b-fake0001";
    const child = spawn(FIXTURE, ["--attach", "--workspace", "/tmp/proj-b"], {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
    });
    try {
      await until(() => fs.existsSync(sessionPath(name)) && sessionAttachedClients(name) === 1);
      fs.writeFileSync(path.join(stateDir, "sessions", `${name}.detach`), "");
      const code = await waitForExit(child);
      expect(code).toBe(3);
      expect(sessionAttachedClients(name)).toBe(0);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });

  it("blocks until an .end control file appears, then exits 0 and removes the session", async () => {
    run(["--start", "--workspace", "/tmp/proj-c"]);
    const name = "proj-c-fake0001";
    const child = spawn(FIXTURE, ["--attach", "--workspace", "/tmp/proj-c"], {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
    });
    try {
      await until(() => fs.existsSync(sessionPath(name)) && sessionAttachedClients(name) === 1);
      fs.writeFileSync(path.join(stateDir, "sessions", `${name}.end`), "");
      const code = await waitForExit(child);
      expect(code).toBe(0);
      expect(fs.existsSync(sessionPath(name))).toBe(false);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });

  it("default (no knob): SIGTERM converts to a numeric exit 3, signal null (pins the existing contract)", async () => {
    run(["--start", "--workspace", "/tmp/proj-sigterm-default"]);
    const name = "proj-sigterm-default-fake0001";
    const child = spawn(FIXTURE, ["--attach", "--workspace", "/tmp/proj-sigterm-default"], {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
    });
    try {
      await until(() => fs.existsSync(sessionPath(name)) && sessionAttachedClients(name) === 1);
      child.kill("SIGTERM");
      const { code, signal } = await waitForExitFull(child);
      expect(code).toBe(3);
      expect(signal).toBeNull();
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });

  it("knobs/attach-signal-death: SIGTERM kills the process outright — code null, signal SIGTERM", async () => {
    run(["--start", "--workspace", "/tmp/proj-sigterm-death"]);
    writeKnob("attach-signal-death");
    const name = "proj-sigterm-death-fake0001";
    const child = spawn(FIXTURE, ["--attach", "--workspace", "/tmp/proj-sigterm-death"], {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
    });
    try {
      await until(() => fs.existsSync(sessionPath(name)) && sessionAttachedClients(name) === 1);
      child.kill("SIGTERM");
      const { code, signal } = await waitForExitFull(child);
      expect(signal).toBe("SIGTERM");
      expect(code).toBeNull();
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });

  it("records the attach pid in sessions/<name>.attach.pid while attached, removes it on clean .detach exit", async () => {
    run(["--start", "--workspace", "/tmp/proj-pidfile"]);
    const name = "proj-pidfile-fake0001";
    const child = spawn(FIXTURE, ["--attach", "--workspace", "/tmp/proj-pidfile"], {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
    });
    try {
      await until(() => fs.existsSync(sessionPath(name)) && sessionAttachedClients(name) === 1);
      await until(() => fs.existsSync(attachPidPath(name)));
      const recordedPid = parseInt(fs.readFileSync(attachPidPath(name), "utf8").trim(), 10);
      expect(recordedPid).toBe(child.pid);

      fs.writeFileSync(path.join(stateDir, "sessions", `${name}.detach`), "");
      const code = await waitForExit(child);
      expect(code).toBe(3);
      expect(fs.existsSync(attachPidPath(name))).toBe(false);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });

  it("--stop with a live attach client: the attach child observes the session vanish and exits 0 on its own", async () => {
    run(["--start", "--workspace", "/tmp/proj-stop-live"]);
    const name = "proj-stop-live-fake0001";
    const child = spawn(FIXTURE, ["--attach", "--workspace", "/tmp/proj-stop-live"], {
      env: { ...process.env, FAKE_SANDY_STATE: stateDir },
    });
    try {
      await until(() => fs.existsSync(sessionPath(name)) && sessionAttachedClients(name) === 1);
      expect(run(["--stop", "--workspace", "/tmp/proj-stop-live"]).code).toBe(0);
      const code = await waitForExit(child);
      expect(code).toBe(0);
    } finally {
      try { child.kill(); } catch { /* already gone */ }
    }
  });
});

describeUnix("fake-sandy: --stop", () => {
  it("removes a running session and exits 0", () => {
    run(["--start", "--workspace", "/tmp/proj-d"]);
    expect(run(["--stop", "--workspace", "/tmp/proj-d"]).code).toBe(0);
    const state = JSON.parse(run(["--print-state"]).stdout);
    expect(state.running_containers).toHaveLength(0);
  });

  it("exits 4 when no session exists", () => {
    expect(run(["--stop", "--workspace", "/tmp/nope-at-all"]).code).toBe(4);
  });
});

describeUnix("fake-sandy: --prune-orphans", () => {
  it("resets the orphans knob; --print-state reflects it before and after", () => {
    writeKnob("orphans", "3");
    expect(JSON.parse(run(["--print-state"]).stdout).orphan_networks).toBe(3);
    expect(run(["--prune-orphans"]).code).toBe(0);
    expect(JSON.parse(run(["--print-state"]).stdout).orphan_networks).toBe(0);
  });
});

describeUnix("fake-sandy: invocation log", () => {
  it("records every invocation in order, argv joined by spaces", () => {
    run(["--version"]);
    run(["--print-schema"]);
    run(["--start", "--workspace", "/tmp/proj-log"]);
    const log = fs.readFileSync(path.join(stateDir, "log"), "utf8").split("\n").filter(Boolean);
    expect(log).toEqual([
      "--version",
      "--print-schema",
      "--start --workspace /tmp/proj-log",
    ]);
  });
});
