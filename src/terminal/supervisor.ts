import * as vscode from "vscode";
import { spawnPty, PtyHandle, SpawnOpts } from "./pty";

// Session lifecycle owner. Each Session is keyed by workspace path: at most
// one sandy per workspace at a time. State machine:
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

export interface Session {
  readonly id: string;                  // workspace path serves as the natural key
  readonly workspacePath: string;
  readonly pty: PtyHandle;
  readonly startedAt: Date;
  panel: vscode.WebviewPanel | undefined;  // current attached panel, undefined = detached
  exited: boolean;
  exitCode?: number;
}

export type SessionEventKind = "spawned" | "attached" | "detached" | "exited";

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
   */
  detach(workspacePath: string): void {
    const session = this.sessions.get(workspacePath);
    if (!session) return;
    session.panel = undefined;
    this.log(`session detached workspace=${workspacePath}`);
    this._onDidChange.fire({ kind: "detached", session });
  }

  /**
   * Force-stop a session via signal escalation: SIGINT → 3s → SIGTERM →
   * 2s → SIGKILL. Used by panel-dispose when user closes the tab without
   * detaching, and by the sandy.tree.stop context-menu command.
   */
  async stop(workspacePath: string): Promise<void> {
    const session = this.sessions.get(workspacePath);
    if (!session || session.exited) return;
    this.log(`stopping session workspace=${workspacePath} pid=${session.pty.pid}`);
    try { session.pty.kill("SIGINT"); } catch { /* may already be dead */ }
    await sleep(3_000);
    if (session.exited) return;
    try { session.pty.kill("SIGTERM"); } catch { /* swallow */ }
    await sleep(2_000);
    if (session.exited) return;
    try { session.pty.kill("SIGKILL"); } catch { /* swallow */ }
  }

  /**
   * Coordinated graceful shutdown for extension.deactivate(). Parallel-
   * SIGINTs every live session so each sandy's cleanup trap (docker stop,
   * docker network rm) runs concurrently. VSCode awaits this with ~5s of
   * budget; we fit a 4s wait + escalation inside that.
   */
  async disposeAll(): Promise<void> {
    const live = this.getAllSessions();
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
