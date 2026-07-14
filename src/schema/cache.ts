import * as cp from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { Schema } from "../settings/configIO";
import type { SandySchema } from "./types";
import { parseSandySchema } from "./parse";
import { resolveSandyBinary } from "../state/sandyPath";

// Cache file lives in the extension's globalStorageUri.
// Layout:
//   {
//     "cache_format":  2,
//     "sandy_version": "0.12.0",
//     "fetched_at":    "2026-04-27T...",
//     "raw":           <SandySchema>,
//     "parsed":        <Schema>
//   }
// Keyed by sandy_version — when sandy upgrades, the cache invalidates.

// Bumped whenever parseSandySchema's *output shape* changes (not just when
// sandy's version changes): a cache written by a pre-0.6.0 sandy-ui for a
// still-current sandy_version would otherwise match the version check but
// carry a `parsed` blob missing fields like `capabilities` forever, since
// nothing would ever invalidate it. Missing cache_format counts as a
// mismatch (pre-format-versioning caches never had the field).
const CACHE_FORMAT = 2;

interface CacheFile {
  cache_format: number;
  sandy_version: string;
  fetched_at: string;
  raw: SandySchema;
  parsed: Schema;
}

export interface SchemaResolution {
  schema: Schema;
  source: "cache" | "fresh" | "fallback";
  sandy_version?: string;
  error?: string;
}

const CACHE_FILE_NAME = "schema-cache.json";

// Async throughout: the previous execFileSync version blocked the extension
// host event loop for up to ~15s (5s --version + 10s --print-schema
// timeouts) on every settings-panel open — 5s even on cache hits when sandy
// or docker wedged (review finding P1).
export async function getCachedSchema(globalStorageDir: string, fallbackMock: Schema): Promise<SchemaResolution> {
  const sandyVersion = await trySandyVersion();
  if (!sandyVersion) {
    return { schema: fallbackMock, source: "fallback", error: "sandy not on PATH" };
  }

  const cachePath = path.join(globalStorageDir, CACHE_FILE_NAME);
  const cached = tryReadCache(cachePath);
  if (cached && cached.sandy_version === sandyVersion) {
    return { schema: cached.parsed, source: "cache", sandy_version: sandyVersion };
  }

  // Stale or missing — refresh.
  return refreshSchema(globalStorageDir, fallbackMock, sandyVersion);
}

export async function refreshSchema(globalStorageDir: string, fallbackMock: Schema, sandyVersion?: string): Promise<SchemaResolution> {
  const version = sandyVersion ?? await trySandyVersion();
  if (!version) {
    return { schema: fallbackMock, source: "fallback", error: "sandy not on PATH" };
  }
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
      sandy_version: version,
      fetched_at: new Date().toISOString(),
      raw,
      parsed,
    };
    const tmp = path.join(globalStorageDir, `${CACHE_FILE_NAME}.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, path.join(globalStorageDir, CACHE_FILE_NAME));
  } catch { /* cache write failure is non-fatal */ }

  return { schema: parsed, source: "fresh", sandy_version: version };
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

async function trySandyVersion(): Promise<string | undefined> {
  const sandyBin = resolveSandyBinary();
  if (!sandyBin) return undefined;
  try {
    const out = (await execFileText(sandyBin, ["--version"], 5_000)).trim();
    // sandy --version prints something like "sandy 0.12.0" or just "0.12.0";
    // grab the first dotted-numeric token.
    const m = out.match(/\b\d+\.\d+\.\d+(?:[\w.-]*)?\b/);
    return m?.[0];
  } catch { return undefined; }
}

async function invokeSandyPrintSchema(): Promise<SandySchema> {
  const sandyBin = resolveSandyBinary();
  if (!sandyBin) throw new Error("sandy not found");
  const out = await execFileText(sandyBin, ["--print-schema"], 10_000);
  return JSON.parse(out) as SandySchema;
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
