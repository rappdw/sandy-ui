// OSC sequence types we intercept on the host side.
// xterm.js parser fires registerOscHandler callbacks on the renderer thread
// (inside the webview); the renderer posts these typed events back to the
// extension host, which dispatches them through this module.

export type OscEvent =
  | { kind: "notification"; code: 9 | 99 | 777; title: string; body?: string }
  | { kind: "clipboard";    target: "c" | "p" | "s" | string; data: string }
  | { kind: "title";        title: string }
  | { kind: "hyperlink";    id: string; uri: string };

// Pure parsers — exported separately so they can be unit-tested without
// pulling in vscode or node-pty.

export function parseOsc9(data: string): OscEvent {
  // OSC 9 ; <text> BEL — iTerm2 / cmux notification. Body is the title only.
  return { kind: "notification", code: 9, title: data };
}

export function parseOsc99(data: string): OscEvent {
  // OSC 99 ; key=val:... ; <body> BEL — the cmux/iTerm2 "rich" variant.
  // For the spike we just split on the last ';' to separate metadata from body.
  const i = data.lastIndexOf(";");
  const head = i >= 0 ? data.slice(0, i) : "";
  const body = i >= 0 ? data.slice(i + 1) : data;
  return { kind: "notification", code: 99, title: head || "(notification)", body };
}

export function parseOsc777(data: string): OscEvent {
  // OSC 777 ; notify ; <title> ; <body> BEL — urxvt / mate-terminal extension.
  const parts = data.split(";");
  if (parts[0] === "notify") {
    return { kind: "notification", code: 777, title: parts[1] ?? "", body: parts[2] };
  }
  return { kind: "notification", code: 777, title: data };
}

export function parseOsc52(data: string): OscEvent | null {
  // OSC 52 ; <selection> ; <base64-or-?> BEL
  const semi = data.indexOf(";");
  if (semi < 0) return null;
  const target = data.slice(0, semi);
  const payload = data.slice(semi + 1);
  if (payload === "?") return null; // read request, not a write — ignore
  let decoded: string;
  try { decoded = Buffer.from(payload, "base64").toString("utf8"); }
  catch { return null; }
  return { kind: "clipboard", target, data: decoded };
}
