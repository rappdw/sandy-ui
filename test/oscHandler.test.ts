import { describe, it, expect } from "vitest";
import { parseOsc9, parseOsc52, parseOsc99, parseOsc777, OscEvent } from "../src/terminal/oscHandler";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("parseOsc9 (iTerm2 / cmux notification)", () => {
  it("returns the data verbatim as the title", () => {
    expect(parseOsc9("hello world")).toEqual({
      kind: "notification", code: 9, title: "hello world",
    });
  });

  it("preserves empty payloads (sandy may emit a bell-only)", () => {
    expect(parseOsc9("")).toEqual({
      kind: "notification", code: 9, title: "",
    });
  });

  it("preserves arbitrary bytes including semicolons and special chars", () => {
    const payload = `; <script>alert(1)</script> & "quoted"`;
    expect(parseOsc9(payload)).toEqual({
      kind: "notification", code: 9, title: payload,
    });
  });
});

describe("parseOsc99 (rich notification)", () => {
  it("splits on the LAST semicolon — head=metadata, body=text", () => {
    const ev = parseOsc99("priority=high:source=ci;Build #42 succeeded") as Extract<OscEvent, { kind: "notification" }>;
    expect(ev.kind).toBe("notification");
    expect(ev.code).toBe(99);
    expect(ev.title).toBe("priority=high:source=ci");
    expect(ev.body).toBe("Build #42 succeeded");
  });

  it("falls back to placeholder title when no semicolon present", () => {
    const ev = parseOsc99("body only no metadata") as Extract<OscEvent, { kind: "notification" }>;
    // No ';' → head is "" → title falls back to "(notification)"; body is full data.
    expect(ev.title).toBe("(notification)");
    expect(ev.body).toBe("body only no metadata");
  });

  it("handles body-with-embedded-semicolons (only LAST split matters)", () => {
    const ev = parseOsc99("k=v;hello; world; this is body") as Extract<OscEvent, { kind: "notification" }>;
    expect(ev.title).toBe("k=v;hello; world");
    expect(ev.body).toBe(" this is body");
  });

  it("trailing semicolon yields empty body", () => {
    const ev = parseOsc99("title;") as Extract<OscEvent, { kind: "notification" }>;
    expect(ev.title).toBe("title");
    expect(ev.body).toBe("");
  });
});

describe("parseOsc777 (urxvt / mate-terminal)", () => {
  it("parses the canonical notify;title;body form", () => {
    expect(parseOsc777("notify;Build done;exit 0")).toEqual({
      kind: "notification", code: 777, title: "Build done", body: "exit 0",
    });
  });

  it("handles missing body (notify;title;)", () => {
    expect(parseOsc777("notify;Title only;")).toEqual({
      kind: "notification", code: 777, title: "Title only", body: "",
    });
  });

  it("handles missing body and trailing-separator (notify;Title)", () => {
    const ev = parseOsc777("notify;Title") as Extract<OscEvent, { kind: "notification" }>;
    expect(ev.title).toBe("Title");
    expect(ev.body).toBeUndefined();
  });

  it("falls back to treating non-notify forms as opaque title", () => {
    // OSC 777 has other subcommands (urxvt-specific). For unsupported ones
    // we just surface the raw payload as the title so the user sees something.
    expect(parseOsc777("font;-misc-fixed-medium-r-normal--14")).toEqual({
      kind: "notification", code: 777, title: "font;-misc-fixed-medium-r-normal--14",
    });
  });
});

describe("parseOsc52 (clipboard)", () => {
  it("decodes the canonical c;base64 form", () => {
    expect(parseOsc52(`c;${b64("clipboard test")}`)).toEqual({
      kind: "clipboard", target: "c", data: "clipboard test",
    });
  });

  it("supports primary (p) and select (s) targets", () => {
    expect(parseOsc52(`p;${b64("primary")}`)).toMatchObject({ target: "p", data: "primary" });
    expect(parseOsc52(`s;${b64("select")}`)).toMatchObject({ target: "s", data: "select" });
  });

  it("decodes binary-safe content (newlines, tabs, unicode)", () => {
    const payload = "line1\nline2\tcolé";  // includes \n \t and é
    expect(parseOsc52(`c;${b64(payload)}`)).toEqual({
      kind: "clipboard", target: "c", data: payload,
    });
  });

  it("returns null on read-request (payload = '?') — never overwrites clipboard", () => {
    expect(parseOsc52("c;?")).toBeNull();
    expect(parseOsc52("p;?")).toBeNull();
  });

  it("returns null when no target/payload separator", () => {
    expect(parseOsc52("no-semicolon-here")).toBeNull();
  });

  it("returns the decoded payload even if it's empty (target;<emptybase64>)", () => {
    // Empty base64 is "" — decoding yields empty string. Not an error.
    expect(parseOsc52("c;")).toEqual({
      kind: "clipboard", target: "c", data: "",
    });
  });

  it("handles base64 with padding correctly", () => {
    // 'A' base64-encodes to "QQ==", decodes back to 'A'
    expect(parseOsc52("c;QQ==")).toMatchObject({ target: "c", data: "A" });
  });
});
