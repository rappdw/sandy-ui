import * as nodePty from "node-pty";
import * as os from "os";

export interface PtyHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number, signal?: number) => void): void;
  kill(signal?: string): void;
  pid: number;
}

export interface SpawnOpts {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

// Whitelist of env vars passed through to the child process.
// Mirrors SPEC_SANDY_UI.md §"Security model" — clean subprocess env.
const ENV_WHITELIST = ["HOME", "USER", "PATH", "LANG", "TERM", "SHELL", "SSH_AUTH_SOCK"];
const ENV_PREFIX_WHITELIST = ["LC_", "SANDY_"];

export function buildCleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_WHITELIST.includes(k))                                   out[k] = v;
    else if (ENV_PREFIX_WHITELIST.some(p => k.startsWith(p)))        out[k] = v;
  }
  // TERM must report something xterm.js can speak; default if shell didn't set one.
  if (!out.TERM) out.TERM = "xterm-256color";
  Object.assign(out, extra);
  return out;
}

export function spawnPty(opts: SpawnOpts): PtyHandle {
  const proc = nodePty.spawn(opts.command, opts.args, {
    name: opts.env.TERM ?? "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd:  opts.cwd,
    env:  opts.env,
  });
  return {
    pid: proc.pid,
    write: (d) => proc.write(d),
    resize: (c, r) => { try { proc.resize(c, r); } catch { /* PTY may have exited */ } },
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(({ exitCode, signal }) => cb(exitCode, signal)),
    kill: (sig) => { try { proc.kill(sig as any); } catch { /* already gone */ } },
  };
}

// Returns candidate launch commands in preference order. The caller spawns
// each in turn, falling back on spawn failure (some entries on PATH may be
// non-executable, broken shims, or quarantined binaries that fail posix_spawnp
// even when existsSync says they're there).
export function launchCandidates(): { command: string; args: string[] }[] {
  const fs = require("fs") as typeof import("fs");
  const paths = (process.env.PATH ?? "").split(":");
  const findExecutable = (bin: string): string | null => {
    for (const p of paths) {
      const full = `${p}/${bin}`;
      try { fs.accessSync(full, fs.constants.X_OK); return full; }
      catch { /* not executable here, try next */ }
    }
    return null;
  };

  const out: { command: string; args: string[] }[] = [];
  const sandy = findExecutable("sandy");
  if (sandy) out.push({ command: sandy, args: [] });
  const tmux  = findExecutable("tmux");
  if (tmux)  out.push({ command: tmux,  args: ["new-session", "-A", "-s", "sandy-spike"] });
  const shell = process.env.SHELL ?? (os.platform() === "win32" ? "powershell.exe" : "/bin/bash");
  out.push({ command: shell, args: shell.endsWith("bash") || shell.endsWith("zsh") ? ["-l"] : [] });
  return out;
}

// Backwards-compat single-pick (still used by tests/smoke).
export function defaultLaunchCommand(): { command: string; args: string[] } {
  return launchCandidates()[0];
}
