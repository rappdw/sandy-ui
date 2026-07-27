// Tolerant JSON extraction for sandy CLI stdout (rappdw/sandy-ui#38).
//
// sandy's introspection commands (--print-state / --print-schema /
// --validate-config) emit a JSON object, but a consumer must not assume the
// stream is byte-perfect. Shell prompt/title hooks that write an OSC
// terminal-title escape (ESC ] 0 ; <title> BEL) to fd 1 instead of the tty
// prepend that escape to any piped/redirected output; dev builds may emit
// notices. jq fails on exactly this (`Invalid numeric literal at line 1
// column 2`), and so did we — found running against a 1.2.2-dev sandy on a
// DGX whose shell leaked an OSC 0 title onto stdout.
//
// Strategy: fast-path JSON.parse (zero behavior change for clean output);
// on failure, slice from the first '{' to the last '}' and retry. Throws the
// ORIGINAL error if neither yields valid JSON, so callers' existing
// error handling / messages are intact. Objects only — every sandy
// introspection payload is a top-level object, so we don't bother with
// array framing.
export function parseSandyJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (firstErr) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      // May still throw if the sliced span isn't valid JSON (e.g. junk that
      // happens to contain braces) — that's fine, the catch below rethrows
      // the original parse error so the caller sees a consistent failure.
      try { return JSON.parse(raw.slice(start, end + 1)) as T; }
      catch { /* fall through to rethrow the original */ }
    }
    throw firstErr;
  }
}
