// Module-level registry of every live sandy PTY spawned by openTerminalPanel.
// Used by extension.deactivate() to coordinate graceful shutdown across ALL
// sandy sessions when VSCode quits — single SIGINT pulse so each sandy's
// cleanup trap (docker stop, docker network rm) runs in parallel rather than
// serial. Per-tab onDidDispose still handles single-tab close independently.

import type { PtyHandle } from "./pty";

const live = new Map<PtyHandle, { exited: boolean; label: string }>();

export function registerPty(pty: PtyHandle, label: string): void {
  live.set(pty, { exited: false, label });
  pty.onExit(() => {
    const e = live.get(pty);
    if (e) e.exited = true;
  });
}

export function unregisterPty(pty: PtyHandle): void {
  live.delete(pty);
}

export function snapshotLivePtys(): { pty: PtyHandle; label: string }[] {
  return [...live.entries()]
    .filter(([, v]) => !v.exited)
    .map(([pty, v]) => ({ pty, label: v.label }));
}

// Wait until every passed-in PTY has exited, OR until timeoutMs elapses.
// Resolves with the count of survivors (PTYs still running at timeout).
export function waitForExits(ptys: PtyHandle[], timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve) => {
    if (ptys.length === 0) return resolve(0);
    let remaining = ptys.length;
    let resolved = false;
    const finish = (n: number) => { if (!resolved) { resolved = true; resolve(n); } };

    for (const p of ptys) {
      const e = live.get(p);
      if (e?.exited) {
        remaining--;
        if (remaining === 0) finish(0);
        continue;
      }
      p.onExit(() => {
        remaining--;
        if (remaining === 0) finish(0);
      });
    }

    setTimeout(() => finish(remaining), timeoutMs);
  });
}
