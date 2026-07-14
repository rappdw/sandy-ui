import * as cp from "child_process";
import * as vscode from "vscode";
import { spawnPty, PtyHandle, SpawnOpts } from "./pty";

// Session lifecycle owner. Each Session is keyed by workspace path: at most
// one sandy per workspace at a time. State machine (direct backend):
//
//   spawn()                    attach(panel)             detach()
//   ──────►  state=running ──────────────►  panel=set  ──────►  panel=undefined
//                                                                    │
//                                                                    │ click tree item
//                                                                    ▼
//                                                              attach(newPanel)
//
// Closing a webview tab does NOT auto-detach — it triggers a stop (signal
// escalation). Detach is opt-in via the sandy.tree.detach command and clears
// session.panel before the close, so the panel-dispose handler sees the
// detached state and skips the kill.
//
// Daemon backend (sandy 1.1.0+, feature-detected via schema capabilities —
// see src/daemon/contract.ts) is a different lifecycle: the supervisor here
// tracks LOCAL CLIENTS only, not the durable daemon session. A daemon
// session whose local attach client exits leaves the supervisor map
// entirely — the durable truth for daemon sessions is `sandy --print-state`,
// consumed elsewhere (Batch 3). Two-phase launch: beginDaemon() registers
// the session around the visible `sandy --start` pty (so the user watches
// image build / seeding live), then promoteToAttach() swaps the same
// session onto a `sandy --attach` pty once --start exits 0.

export interface Session {
  readonly id: string;                  // workspace path serves as the natural key
  readonly workspacePath: string;
  readonly backend: "direct" | "daemon";
  pty: PtyHandle;                       // mutable: promoteToAttach() swaps start-pty → attach-pty
  readonly startedAt: Date;
  panel: vscode.WebviewPanel | undefined;  // current attached panel, undefined = detached
  exited: boolean;
  exitCode?: number;
  // Set by detach() (daemon backend only) BEFORE killing the local attach
  // client, so promoteToAttach's onExit can treat the outcome as "detached"
  // deterministically instead of relying on the exit code an externally
  // signalled client produces (unverified for signals — the contract's
  // exit-3-means-detached table is for the user-driven `sandy --attach`
  // detach keystroke, not for us SIGKILLing our own client).
  detachRequested?: boolean;
}

export type SessionEventKind = "spawned" | "attached" | "detached" | "exited" | "client-detached";

export interface SessionEvent {
  kind: SessionEventKind;
  session: Session;
}

export interface SpawnSessionOpts extends SpawnOpts {
  workspacePath: string;
}

export class PtySupervisor implements vscode.Disposable {
  private readonly sessions = new Map<string, Session>();
  private readonly _onDidChange = new vscode.EventEmitter<SessionEvent>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly out?: vscode.OutputChannel) {}

  /** Returns the live Session for this workspace, or undefined if none. */
  getSession(workspacePath: string): Session | undefined {
    const s = this.sessions.get(workspacePath);
    return s && !s.exited ? s : undefined;
  }

  /** Snapshot of every live session (excludes exited entries). */
  getAllSessions(): Session[] {
    return [...this.sessions.values()].filter(s => !s.exited);
  }

  /**
   * Spawn a new sandy session for the given workspace. If a live session
   * already exists, returns it instead (caller should attach a panel via
   * attach()).
   */
  spawn(opts: SpawnSessionOpts): Session {
    const existing = this.getSession(opts.workspacePath);
    if (existing) return existing;

    const pty = spawnPty(opts);
    const session: Session = {
      id: opts.workspacePath,
      workspacePath: opts.workspacePath,
      backend: "direct",
      pty,
      startedAt: new Date(),
      panel: undefined,
      exited: false,
    };
    this.sessions.set(session.id, session);

    // Re-read session.panel on every chunk so re-attach redirects the stream
    // to the new panel automatically. While detached, data is silently
    // discarded (no scrollback replay on re-attach for now — sandy's inner
    // tmux preserves the live screen, so the next interaction repaints).
    pty.onData((d) => {
      const p = session.panel;
      if (p) p.webview.postMessage({ type: "data", data: d });
    });
    pty.onExit((code) => {
      session.exited = true;
      session.exitCode = code;
      const p = session.panel;
      if (p) p.webview.postMessage({ type: "exit", code });
      this.log(`session exited workspace=${session.workspacePath} code=${code}`);
      this._onDidChange.fire({ kind: "exited", session });
    });

    this.log(`session spawned workspace=${session.workspacePath} pid=${pty.pid}`);
    this._onDidChange.fire({ kind: "spawned", session });
    return session;
  }

  /**
   * Phase 1 of the two-phase daemon launch (Batch 2 wires the caller):
   * registers a daemon-backed session around the RUNNING `sandy --start`
   * pty. Pipes data to the panel exactly like spawn() does, so the user
   * watches image build / seeding live instead of a blank terminal.
   *
   * Its onExit does NOT mark the session exited — a `--start` exit of 0 is
   * the success path, immediately followed by promoteToAttach(), not a
   * session death. A nonzero start failure still surfaces in the terminal
   * (data was piped live), same as today's spawn failures; deciding what to
   * do next is the caller's job, not the supervisor's.
   */
  beginDaemon(workspacePath: string, pty: PtyHandle): Session {
    const session: Session = {
      id: workspacePath,
      workspacePath,
      backend: "daemon",
      pty,
      startedAt: new Date(),
      panel: undefined,
      exited: false,
    };
    this.sessions.set(session.id, session);

    pty.onData((d) => {
      if (session.pty !== pty) return; // superseded by promoteToAttach
      const p = session.panel;
      if (p) p.webview.postMessage({ type: "data", data: d });
    });
    pty.onExit((code) => {
      if (session.pty !== pty) return; // stale callback from a superseded pty
      this.log(`daemon start pty exited workspace=${session.workspacePath} code=${code}`);
    });

    this.log(`daemon session started workspace=${session.workspacePath} pid=${pty.pid}`);
    this._onDidChange.fire({ kind: "spawned", session });
    return session;
  }

  /**
   * Phase 2 of the two-phase daemon launch: replaces session.pty with the
   * `sandy --attach` pty (once `--start` exited 0), wires data piping, and
   * classifies the attach pty's eventual exit via classifyAttachExit:
   *   - "detached" (code 3) → user cleanly detached, session lives on the
   *     host. Removed from the map (the supervisor tracks local clients
   *     only); {kind:"client-detached"} fires so callers can update UI.
   *   - "ended" | "no-session" | "failed" → session is over. Marked exited,
   *     exit posted to the panel (existing behavior), removed from the map,
   *     {kind:"exited"} fires.
   * The old start-pty's onData/onExit (registered in beginDaemon) guard on
   * `session.pty === thisPty` so they stop posting once superseded here —
   * same pattern this method also applies to its own callbacks, in case a
   * session is promoted more than once.
   */
  promoteToAttach(workspacePath: string, pty: PtyHandle): void {
    const session = this.sessions.get(workspacePath);
    if (!session) return;
    const { classifyAttachExit } = require("../daemon/contract") as typeof import("../daemon/contract");

    session.pty = pty;

    pty.onData((d) => {
      if (session.pty !== pty) return; // superseded by a later promote
      const p = session.panel;
      if (p) p.webview.postMessage({ type: "data", data: d });
    });
    pty.onExit((code) => {
      if (session.pty !== pty) return; // stale callback from a superseded pty
      if (!this.sessions.has(session.id)) return; // already removed (e.g. via stopDaemon's own completion race)
      // detachRequested wins over the exit-code table: exit 3 is the
      // contract for a user-driven detach keystroke inside tmux, but an
      // externally-signalled client's exit code is unspecified — and when
      // WE initiated the kill (detach()), the intent IS detach regardless
      // of what code the OS reports.
      const outcome = session.detachRequested ? "detached" : classifyAttachExit(code);
      if (outcome === "detached") {
        this.log(`daemon client detached workspace=${session.workspacePath}`);
        this.sessions.delete(session.id);
        this._onDidChange.fire({ kind: "client-detached", session });
        return;
      }
      session.exited = true;
      session.exitCode = code;
      const p = session.panel;
      if (p) p.webview.postMessage({ type: "exit", code });
      this.log(`daemon session exited workspace=${session.workspacePath} code=${code} outcome=${outcome}`);
      this.sessions.delete(session.id);
      this._onDidChange.fire({ kind: "exited", session });
    });

    this.log(`promoted to attach workspace=${session.workspacePath} pid=${pty.pid}`);
  }

  /**
   * Abort a daemon session that never got past `sandy --start` (nonzero
   * exit). beginDaemon() deliberately leaves this decision to the caller —
   * a start failure means promoteToAttach() never runs, so nothing else
   * would mark the session exited or clean it out of the map. Mirrors the
   * exit-handling tail of promoteToAttach's onExit (mark exited, post the
   * exit message if a panel is still attached, remove from map, fire the
   * exited event) so callers get the same UI outcome as any other session
   * death.
   */
  abortDaemonStart(workspacePath: string, code: number): void {
    const session = this.sessions.get(workspacePath);
    if (!session || session.exited) return;
    session.exited = true;
    session.exitCode = code;
    const p = session.panel;
    if (p) p.webview.postMessage({ type: "exit", code });
    this.log(`daemon start aborted workspace=${session.workspacePath} code=${code}`);
    this.sessions.delete(session.id);
    this._onDidChange.fire({ kind: "exited", session });
  }

  /**
   * Attach a webview panel to a live session. Caller is responsible for
   * sending the panel any initial dimensions via pty.resize() before
   * attach.
   */
  attach(workspacePath: string, panel: vscode.WebviewPanel): Session | undefined {
    const session = this.getSession(workspacePath);
    if (!session) return undefined;
    session.panel = panel;
    this.log(`session attached workspace=${workspacePath}`);
    this._onDidChange.fire({ kind: "attached", session });
    return session;
  }

  /**
   * Detach the panel from a session WITHOUT killing the PTY. The PTY keeps
   * running (sandy stays up); a future attach() rebinds data flow to a new
   * panel. Caller is expected to also dispose the panel after this returns;
   * the panel-dispose handler should check session.panel and skip the kill
   * because it'll be undefined.
   *
   * Daemon sessions additionally kill the attach pty after clearing the
   * panel: that's the local client's own exit path (the host-side session
   * is untouched), and its exit code 3 ("detached") is what
   * promoteToAttach's exit wiring uses to remove the session from the map.
   */
  detach(workspacePath: string): void {
    const session = this.sessions.get(workspacePath);
    if (!session) return;
    session.panel = undefined;
    this.log(`session detached workspace=${workspacePath}`);
    this._onDidChange.fire({ kind: "detached", session });
    if (session.backend === "daemon") {
      // Set BEFORE kill(): promoteToAttach's onExit reads this flag to know
      // the kill it's about to observe was WE-initiated detach intent, not
      // some other failure — see the Session.detachRequested doc comment.
      session.detachRequested = true;
      try { session.pty.kill(); } catch { /* may already be dead */ }
    }
  }

  /**
   * Force-stop a session. Direct backend: signal escalation SIGINT → 3s →
   * SIGTERM → 2s → SIGKILL. Used by panel-dispose when user closes the tab
   * without detaching, and by the sandy.tree.stop context-menu command.
   * Daemon backend delegates to stopDaemon() — see its doc comment for why
   * signal escalation is wrong there.
   */
  async stop(workspacePath: string): Promise<void> {
    const session = this.sessions.get(workspacePath);
    if (!session || session.exited) return;
    if (session.backend === "daemon") {
      await this.stopDaemon(session);
      return;
    }
    this.log(`stopping session workspace=${workspacePath} pid=${session.pty.pid}`);
    try { session.pty.kill("SIGINT"); } catch { /* may already be dead */ }
    if (await this.waitForExit(session, 3_000)) return;
    try { session.pty.kill("SIGTERM"); } catch { /* swallow */ }
    if (await this.waitForExit(session, 2_000)) return;
    try { session.pty.kill("SIGKILL"); } catch { /* swallow */ }
  }

  /**
   * Daemon teardown goes through `sandy --stop`, not signal escalation: the
   * pty the supervisor holds for a daemon session is just a local attach
   * client, not the host-side supervisor process — killing it would only
   * detach us, not tear down the container. 60s timeout because teardown
   * includes `docker stop`. The local attach client (if any) observes the
   * container vanish and exits 0 on its own, which promoteToAttach's exit
   * wiring already turns into {kind:"exited"} + map removal; this
   * defensively does the same after execFile completes in case that race
   * doesn't resolve first.
   */
  private async stopDaemon(session: Session): Promise<void> {
    const { resolveSandyBinary } = require("../state/sandyPath") as typeof import("../state/sandyPath");
    const { stopArgs, STOP_EXIT } = require("../daemon/contract") as typeof import("../daemon/contract");
    const sandyBin = resolveSandyBinary();
    if (!sandyBin) {
      this.log(`stopDaemon: sandy binary not found, cannot --stop workspace=${session.workspacePath}`);
      return;
    }
    this.log(`stopping daemon session workspace=${session.workspacePath} via sandy --stop`);
    await new Promise<void>((resolve) => {
      cp.execFile(sandyBin, stopArgs(session.workspacePath), { timeout: 60_000 }, (err: any) => {
        const label =
          !err ? "stopped" :
          err.code === "ENOENT" ? "sandy binary missing" :
          err.killed || err.signal ? "timed out after 60s" :
          err.code === STOP_EXIT.NO_SESSION ? "no-session" :
          err.code === STOP_EXIT.FAILED ? "failed" :
          `error:${err.message}`;
        this.log(`sandy --stop workspace=${session.workspacePath} result=${label}`);
        resolve();
      });
    });
    if (this.sessions.has(session.id) && !session.exited) {
      session.exited = true;
      const p = session.panel;
      if (p) p.webview.postMessage({ type: "exit", code: 0 });
      this.sessions.delete(session.id);
      this._onDidChange.fire({ kind: "exited", session });
    }
  }

  // Resolves true as soon as the session exits, false at the timeout. The
  // fixed sleep() this replaces held tab-close disposal for the full 3s+2s
  // escalation window even when sandy exited instantly.
  private waitForExit(session: Session, timeoutMs: number): Promise<boolean> {
    if (session.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (v: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => finish(session.exited), timeoutMs);
      session.pty.onExit(() => finish(true));
    });
  }

  /**
   * Coordinated graceful shutdown for extension.deactivate(). Parallel-
   * SIGINTs every live DIRECT-backend session so each sandy's cleanup trap
   * (docker stop, docker network rm) runs concurrently. VSCode awaits this
   * with ~5s of budget; we fit a 4s wait + escalation inside that.
   *
   * Daemon-backend sessions are deliberately excluded: daemon clients die
   * with the extension host BY DESIGN (that's the feature — the host-side
   * session survives VSCode quitting), so there is nothing to signal.
   */
  async disposeAll(): Promise<void> {
    const all = this.getAllSessions();
    const live = all.filter(s => s.backend === "direct");
    const daemonCount = all.length - live.length;
    if (daemonCount > 0) {
      this.log(`disposeAll: leaving ${daemonCount} daemon session(s) running (survive by design)`);
    }
    if (live.length === 0) return;
    this.log(`disposeAll: SIGINT to ${live.length} session(s)`);
    for (const s of live) {
      try { s.pty.kill("SIGINT"); } catch { /* swallow */ }
    }
    const survivors = await this.waitForExits(live, 4_000);
    if (survivors === 0) { this.log("disposeAll: all exited cleanly"); return; }
    this.log(`disposeAll: ${survivors} survivor(s), escalating to SIGTERM`);
    for (const s of live) {
      try { s.pty.kill("SIGTERM"); } catch { /* swallow */ }
    }
    await sleep(800);
    for (const s of live) {
      try { s.pty.kill("SIGKILL"); } catch { /* swallow */ }
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private waitForExits(sessions: Session[], timeoutMs: number): Promise<number> {
    return new Promise<number>((resolve) => {
      if (sessions.length === 0) return resolve(0);
      let remaining = sessions.length;
      let resolved = false;
      const finish = (n: number) => { if (!resolved) { resolved = true; resolve(n); } };
      for (const s of sessions) {
        if (s.exited) {
          remaining--;
          if (remaining === 0) finish(0);
          continue;
        }
        s.pty.onExit(() => {
          remaining--;
          if (remaining === 0) finish(0);
        });
      }
      setTimeout(() => finish(remaining), timeoutMs);
    });
  }

  private log(msg: string): void {
    this.out?.appendLine(`[${new Date().toISOString()}] ${msg}`);
  }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
