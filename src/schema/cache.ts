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
//     "sandy_version": "0.12.0",
//     "fetched_at":    "2026-04-27T...",
//     "raw":           <SandySchema>,
//     "parsed":        <Schema>
//   }
// Keyed by sandy_version — when sandy upgrades, the cache invalidates.

interface CacheFile {
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

export function getCachedSchema(globalStorageDir: string, fallbackMock: Schema): SchemaResolution {
  const sandyVersion = trySandyVersion();
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

export function refreshSchema(globalStorageDir: string, fallbackMock: Schema, sandyVersion?: string): SchemaResolution {
  const version = sandyVersion ?? trySandyVersion();
  if (!version) {
    return { schema: fallbackMock, source: "fallback", error: "sandy not on PATH" };
  }
  let raw: SandySchema;
  try {
    raw = invokeSandyPrintSchema();
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

function trySandyVersion(): string | undefined {
  const sandyBin = resolveSandyBinary();
  if (!sandyBin) return undefined;
  try {
    const out = cp.execFileSync(sandyBin, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    }).trim();
    // sandy --version prints something like "sandy 0.12.0" or just "0.12.0";
    // grab the first dotted-numeric token.
    const m = out.match(/\b\d+\.\d+\.\d+(?:[\w.-]*)?\b/);
    return m?.[0];
  } catch { return undefined; }
}

function invokeSandyPrintSchema(): SandySchema {
  const sandyBin = resolveSandyBinary();
  if (!sandyBin) throw new Error("sandy not found");
  const out = cp.execFileSync(sandyBin, ["--print-schema"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(out) as SandySchema;
}

function tryReadCache(cachePath: string): CacheFile | undefined {
  try {
    if (!fs.existsSync(cachePath)) return undefined;
    return JSON.parse(fs.readFileSync(cachePath, "utf8")) as CacheFile;
  } catch { return undefined; }
}
