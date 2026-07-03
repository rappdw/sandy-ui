import * as os from "os";
import * as path from "path";

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

// Common install dirs to append to the spawned process's PATH. VSCode launched
// from the Dock on macOS inherits launchd's narrow PATH (/usr/bin:/bin:
// /usr/sbin:/sbin) — no Homebrew, no ~/.local/bin. Sandy itself uses
// resolveSandyBinary to dodge this for finding `sandy`, but sandy then tries
// to invoke OTHER tools (socat for SSH agent mode, python3 for the relay,
// gh for token auth, docker, etc.) via plain PATH lookup. Without this
// augmentation those lookups fail with messages like "SANDY_SSH=agent
// requires socat on macOS" even when socat is installed.
//
// Appended (not prepended) so user-controlled PATH entries still win.
const PATH_AUGMENTATIONS = [
  "/opt/homebrew/bin",                          // Homebrew on Apple Silicon
  "/usr/local/bin",                             // Homebrew on Intel + most Linux
  path.join(os.homedir(), ".local/bin"),        // user-local install
  path.join(os.homedir(), "bin"),               // ~/bin
];

export function augmentPath(originalPath: string | undefined): string {
  const segments = (originalPath ?? "").split(path.delimiter).filter(Boolean);
  const seen = new Set(segments);
  for (const dir of PATH_AUGMENTATIONS) {
    if (!seen.has(dir)) {
      segments.push(dir);
      seen.add(dir);
    }
  }
  return segments.join(path.delimiter);
}

export function buildCleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_WHITELIST.includes(k))                                   out[k] = v;
    else if (ENV_PREFIX_WHITELIST.some(p => k.startsWith(p)))        out[k] = v;
  }
  // Augment PATH so child processes (sandy itself, plus any binary sandy
  // invokes — socat, python3, gh, docker, etc.) can resolve them even when
  // VSCode was launched from the Dock with macOS's narrow launchd PATH.
  out.PATH = augmentPath(out.PATH);
  // TERM must report something xterm.js can speak; default if shell didn't set one.
  if (!out.TERM) out.TERM = "xterm-256color";
  Object.assign(out, extra);
  return out;
}

export function spawnPty(opts: SpawnOpts): PtyHandle {
  // Lazy-require node-pty so importing this module for its pure helpers
  // (augmentPath, buildCleanEnv, launchCandidates) never loads the native
  // binding — that load fails outright off-platform (unit tests on a
  // different OS/arch) and is wasted startup cost when nothing spawns.
  const nodePty = require("node-pty") as typeof import("node-pty");
  const proc = nodePty.spawn(opts.command, opts.args, {
    name: opts.env.TERM ?? "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd:  opts.cwd,
    env:  opts.env,
  });
  return {
    pid: proc.pid,
    write: (d) => { try { proc.write(d); } catch { /* PTY may have exited */ } },
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
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  const findExecutable = (bin: string): string | null => {
    for (const p of paths) {
      const full = path.join(p, bin);
      try { fs.accessSync(full, fs.constants.X_OK); return full; }
      catch { /* not executable here, try next */ }
    }
    return null;
  };

  const out: { command: string; args: string[] }[] = [];
  // Use the same resolver as state polling — handles dock-launched VSCode
  // where PATH is narrower than the user's interactive shell.
  // Imported lazily here to keep this module independent of vscode for tests.
  let sandyResolved: string | undefined;
  try {
    sandyResolved = (require("../state/sandyPath") as typeof import("../state/sandyPath")).resolveSandyBinary();
  } catch { /* vscode not available (running outside extension host) — fall through to PATH */ }
  const sandy = sandyResolved ?? findExecutable("sandy");
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
