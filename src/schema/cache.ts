import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { Schema } from "../settings/configIO";
import type { SandySchema } from "./types";
import { parseSandySchema } from "./parse";
import { resolveSandyBinary } from "../state/sandyPath";
import { parseSandyJson } from "../state/parseJson";

// Cache file lives in the extension's globalStorageUri.
// Layout:
//   {
//     "cache_format":  3,
//     "cache_key":     "2.8.0-dev+abc1234|1767225600000|1048576",
//     "sandy_version": "2.8.0-dev",
//     "fetched_at":    "2026-04-27T...",
//     "raw":           <SandySchema>,
//     "parsed":        <Schema>   (written for inspection; never read back)
//   }
//
// Keyed on WHICH sandy binary, not just its version string (sandy-ui#44):
// sandy's installer and `sandy --upgrade` install main HEAD, so many builds
// share one version (e.g. 2.8.0-dev), and curl installs report an empty
// commit. The key is `--print-version`'s full_version plus the binary's
// mtime and size, so any reinstall refetches.
//
// On a hit the RAW schema is re-parsed rather than trusting `parsed`: parsing
// is cheap, and a `parsed` blob written by an older sandy-ui would otherwise
// carry its old shape (no approvalsReport capability, no agent options) for as
// long as sandy stays the same.

// Bumped whenever parseSandySchema's *output shape* changes (not just when
// sandy's version changes): a cache written by a pre-0.6.0 sandy-ui for a
// still-current sandy_version would otherwise match the version check but
// carry a `parsed` blob missing fields like `capabilities` forever, since
// nothing would ever invalidate it. Missing cache_format counts as a
// mismatch (pre-format-versioning caches never had the field).
const CACHE_FORMAT = 3;

interface CacheFile {
  cache_format: number;
  cache_key: string;
  sandy_version: string;
  fetched_at: string;
  raw: SandySchema;
  parsed: Schema;
}

export interface SchemaResolution {
  schema: Schema;
  source: "cache" | "fresh" | "fallback";
  sandy_version?: string;
  // Real sandy's schema_version from the raw --print-schema payload — NOT
  // the bundled mock's (deliberately absent on "fallback" resolutions, since
  // the compat gate (rappdw/sandy-ui#30) must not evaluate the mock's
  // version as if it were the installed sandy's).
  schema_version?: number;
  error?: string;
}

const CACHE_FILE_NAME = "schema-cache.json";

// Async throughout: the previous execFileSync version blocked the extension
// host event loop for up to ~15s (5s --version + 10s --print-schema
// timeouts) on every settings-panel open — 5s even on cache hits when sandy
// or docker wedged (review finding P1).
export async function getCachedSchema(globalStorageDir: string, fallbackMock: Schema): Promise<SchemaResolution> {
  const identity = await trySandyIdentity();
  if (!identity) {
    return { schema: fallbackMock, source: "fallback", error: "sandy not on PATH" };
  }

  const cachePath = path.join(globalStorageDir, CACHE_FILE_NAME);
  const cached = tryReadCache(cachePath);
  if (cached && cached.cache_key === identity.cacheKey) {
    try {
      return {
        schema: parseSandySchema(cached.raw),
        source: "cache",
        sandy_version: identity.version,
        schema_version: cached.raw.schema_version,
      };
    } catch { /* unparseable cache — refresh below */ }
  }

  // Stale or missing — refresh.
  return refreshSchema(globalStorageDir, fallbackMock, identity);
}

export async function refreshSchema(globalStorageDir: string, fallbackMock: Schema, known?: SandyIdentity): Promise<SchemaResolution> {
  const identity = known ?? await trySandyIdentity();
  if (!identity) {
    return { schema: fallbackMock, source: "fallback", error: "sandy not on PATH" };
  }
  const version = identity.version;
  let raw: SandySchema;
  try {
    raw = await invokeSandyPrintSchema();
  } catch (e: any) {
    return {
      schema: fallbackMock,
      source: "fallback",
      sandy_version: version,
      error: `sandy --print-schema failed: ${e?.message ?? e}`,
    };
  }
  let parsed: Schema;
  try {
    parsed = parseSandySchema(raw);
  } catch (e: any) {
    return {
      schema: fallbackMock,
      source: "fallback",
      sandy_version: version,
      error: `parseSandySchema failed: ${e?.message ?? e}`,
    };
  }
  // Best-effort cache write — never fail the request because we couldn't write.
  try {
    fs.mkdirSync(globalStorageDir, { recursive: true });
    const cache: CacheFile = {
      cache_format: CACHE_FORMAT,
      cache_key: identity.cacheKey,
      sandy_version: version,
      fetched_at: new Date().toISOString(),
      raw,
      parsed,
    };
    const tmp = path.join(globalStorageDir, `${CACHE_FILE_NAME}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, path.join(globalStorageDir, CACHE_FILE_NAME));
  } catch { /* cache write failure is non-fatal */ }

  return { schema: parsed, source: "fresh", sandy_version: version, schema_version: raw.schema_version };
}

// --- internals -------------------------------------------------------------

function execFileText(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    cp.execFile(cmd, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export interface SandyIdentity {
  /** sandy's version, for display and the compat gate. */
  version: string;
  /** What the schema cache is keyed on: which build, at which install. */
  cacheKey: string;
}

/** `sandy --print-version` (1.7.0+, #159): {schema_version, version, commit, full_version}. */
export function parsePrintVersion(stdout: string): { version: string; fullVersion: string } | undefined {
  try {
    const j = parseSandyJson<{ version?: unknown; full_version?: unknown }>(stdout);
    if (typeof j?.version !== "string" || j.version === "") return undefined;
    const full = typeof j.full_version === "string" && j.full_version !== "" ? j.full_version : j.version;
    return { version: j.version, fullVersion: full };
  } catch { return undefined; }
}

/** Last resort for a sandy without --print-version: the first dotted version in `sandy --version`. */
export function scrapeVersion(stdout: string): string | undefined {
  return stdout.match(/\b\d+\.\d+\.\d+(?:[\w.-]*)?\b/)?.[0];
}

/** The cache key: the build's full version plus the installed file's mtime and size. */
export function identityKey(fullVersion: string, file: { mtimeMs: number; size: number } | undefined): string {
  return file ? `${fullVersion}|${Math.floor(file.mtimeMs)}|${file.size}` : fullVersion;
}

async function trySandyIdentity(): Promise<SandyIdentity | undefined> {
  const sandyBin = resolveSandyBinary();
  if (!sandyBin) return undefined;
  let parsed: { version: string; fullVersion: string } | undefined;
  try { parsed = parsePrintVersion(await execFileText(sandyBin, ["--print-version"], 5_000)); }
  catch { /* older sandy, or it failed — fall back to --version */ }
  if (!parsed) {
    try {
      const v = scrapeVersion(await execFileText(sandyBin, ["--version"], 5_000));
      if (v) parsed = { version: v, fullVersion: v };
    } catch { /* no version at all */ }
  }
  if (!parsed) return undefined;
  let file: fs.Stats | undefined;
  try { file = fs.statSync(fs.realpathSync(sandyBin)); } catch { /* key on the version alone */ }
  return { version: parsed.version, cacheKey: identityKey(parsed.fullVersion, file) };
}

async function invokeSandyPrintSchema(): Promise<SandySchema> {
  const sandyBin = resolveSandyBinary();
  if (!sandyBin) throw new Error("sandy not found");
  const out = await execFileText(sandyBin, ["--print-schema"], 10_000);
  return parseSandyJson<SandySchema>(out);
}

function tryReadCache(cachePath: string): CacheFile | undefined {
  try {
    if (!fs.existsSync(cachePath)) return undefined;
    const cache = JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheFile;
    // cache_format mismatch (including missing — pre-format-versioning
    // caches never had the field) means the parsed shape can't be trusted;
    // treat it the same as a miss so refreshSchema regenerates it.
    if (cache.cache_format !== CACHE_FORMAT) return undefined;
    return cache;
  } catch { return undefined; }
}
