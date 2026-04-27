import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// vscode is imported lazily inside readOverride() so this module can be
// imported by unit tests that don't have vscode available. When vscode is
// missing (test env without explicit mock), the override path returns "" and
// resolution falls through to PATH lookup + common locations.

// Resolves the absolute path to the sandy binary, even when VSCode's extension
// host has a narrower PATH than the user's interactive shell (the typical
// "launched from Dock" failure mode on macOS).
//
// Resolution order:
//   1. `sandy.binaryPath` config setting (user-explicit override)
//   2. PATH lookup for "sandy" (works when VSCode was launched from a shell)
//   3. Common install locations (Homebrew arm64/x64, user-local, ~/bin, etc.)
//
// Result is cached per-process to avoid the search on every invocation. Call
// invalidateSandyPathCache() if the user updates the setting at runtime.

const COMMON_INSTALL_DIRS = [
  "/opt/homebrew/bin",                          // Homebrew on Apple Silicon
  "/usr/local/bin",                             // Homebrew on Intel + most Linux
  path.join(os.homedir(), ".local/bin"),        // user-local install
  path.join(os.homedir(), "bin"),               // ~/bin
  "/usr/bin",                                    // distro packages
];

let cached: string | undefined;

export function resolveSandyBinary(): string | undefined {
  if (cached) return cached;

  // 1. Explicit override from settings
  const override = readOverride();
  if (override) {
    if (isExecutable(override)) { cached = override; return override; }
    // Configured but not found — return undefined; caller logs.
    return undefined;
  }

  // 2. PATH lookup
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, "sandy");
    if (isExecutable(candidate)) { cached = candidate; return candidate; }
  }

  // 3. Common install locations (handles dock-launched VSCode where PATH is
  // /usr/bin:/bin only)
  for (const dir of COMMON_INSTALL_DIRS) {
    const candidate = path.join(dir, "sandy");
    if (isExecutable(candidate)) { cached = candidate; return candidate; }
  }

  return undefined;
}

export function invalidateSandyPathCache(): void {
  cached = undefined;
}

function isExecutable(p: string): boolean {
  try { fs.accessSync(p, fs.constants.X_OK); return true; }
  catch { return false; }
}

// Override reader is injectable so unit tests can supply a stub without
// needing vscode mocked. Production: defaultOverrideReader (reads the
// sandy.binaryPath config setting). Tests: setOverrideReaderForTests().
type OverrideReader = () => string;

function defaultOverrideReader(): string {
  try {
    const vscode = require("vscode") as typeof import("vscode");
    return (vscode.workspace.getConfiguration("sandy").get<string>("binaryPath", "") ?? "").trim();
  } catch {
    return "";  // vscode unavailable (e.g., unit tests without mock) — no override
  }
}

let overrideReader: OverrideReader = defaultOverrideReader;
function readOverride(): string { return overrideReader(); }

/** Test-only: replace the override reader. Pass undefined to restore default. */
export function setOverrideReaderForTests(fn: OverrideReader | undefined): void {
  overrideReader = fn ?? defaultOverrideReader;
  invalidateSandyPathCache();
}
