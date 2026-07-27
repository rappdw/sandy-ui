import { describe, it, expect } from "vitest";
import { parseSandyJson } from "../src/state/parseJson";

describe("parseSandyJson", () => {
  it("parses clean JSON (fast path, unchanged)", () => {
    expect(parseSandyJson('{"schema_version":1,"a":"b"}')).toEqual({ schema_version: 1, a: "b" });
  });

  it("strips a leading OSC terminal-title escape (the DGX case, #38)", () => {
    // ESC ] 0 ; <title> BEL  prepended by a shell title hook writing to fd 1.
    const raw = '\x1b]0;spark-bf5a:laca (main): sandy\x07{"schema_version":1,"sandboxes":[]}';
    expect(parseSandyJson(raw)).toEqual({ schema_version: 1, sandboxes: [] });
  });

  it("strips a leading plain-text notice line", () => {
    const raw = 'sandy: a new dev build is available (0a6d15f)\n{"schema_version":1}';
    expect(parseSandyJson(raw)).toEqual({ schema_version: 1 });
  });

  it("strips leading ANSI color codes", () => {
    const raw = '\x1b[33m\x1b[1m{"ok":true}\x1b[0m';
    expect(parseSandyJson(raw)).toEqual({ ok: true });
  });

  it("tolerates trailing junk after the object", () => {
    const raw = '{"ok":true}\ntrailing garbage line';
    expect(parseSandyJson(raw)).toEqual({ ok: true });
  });

  it("handles leading whitespace/newlines", () => {
    expect(parseSandyJson('\n\n  {"ok":true}\n')).toEqual({ ok: true });
  });

  it("throws the original error when there is no JSON object at all", () => {
    expect(() => parseSandyJson("not json, no braces here")).toThrow();
  });

  it("throws on empty input", () => {
    expect(() => parseSandyJson("")).toThrow();
  });

  it("preserves a brace-containing string value inside the payload", () => {
    // last '}' must not truncate a legitimate trailing value; a clean parse
    // takes the fast path anyway, but verify the sliced path is exact.
    const raw = '\x1b]0;t\x07{"msg":"has } brace","n":2}';
    expect(parseSandyJson(raw)).toEqual({ msg: "has } brace", n: 2 });
  });
});
