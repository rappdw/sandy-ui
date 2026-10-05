import { describe, it, expect } from "vitest";
import { newRestartWatch, observeRestart, updateSessionsArgs, restartStartFailed, RestartWatch, RestartVerdict } from "../src/daemon/restart";

const feed = (obs: Array<{ updated_at?: string | null } | undefined>, stepMs = 2_000) => {
  let w: RestartWatch = newRestartWatch();
  const out: RestartVerdict[] = [];
  obs.forEach((o, i) => { const r = observeRestart(w, o, i * stepMs); w = r.watch; out.push(r.verdict); });
  return out;
};
const W = "waiting";

describe("observeRestart (sandy --update-sessions restart detection)", () => {
  it("container gone, then back: restarted", () => {
    expect(feed([undefined, undefined, { updated_at: "2026-10-05T03:00:00Z" }])).toEqual([W, W, "restarted"]);
  });
  it("old container briefly still listed (slow stop), then gone, then back: restarted", () => {
    expect(feed([{ updated_at: null }, { updated_at: null }, undefined, { updated_at: "T" }])).toEqual([W, W, W, "restarted"]);
  });
  it("a new updated_at while listed: restarted", () => {
    expect(feed([{ updated_at: "A" }, { updated_at: "B" }])).toEqual([W, "restarted"]);
  });
  it("same container still listed past the grace window: the user ended it", () => {
    const v = feed(Array.from({ length: 9 }, () => ({ updated_at: null })));   // 0s … 16s
    expect(v.slice(0, 8).every((x) => x === W)).toBe(true);                     // up to 14s
    expect(v[8]).toBe("user-ended");                                            // 16s ≥ 15s
  });
  it("never comes back (stopped for good): keeps waiting (the overall bound ends it)", () => {
    expect(feed([undefined, undefined, undefined])).toEqual([W, W, W]);
  });
  it("gone then back even with updated_at null (restarted by hand): restarted", () => {
    expect(feed([{ updated_at: null }, undefined, { updated_at: null }])).toEqual([W, W, "restarted"]);
  });
});

describe("updateSessionsArgs", () => {
  it("scopes to one workspace, always --yes, never --idle-for", () => {
    expect(updateSessionsArgs("/w")).toEqual(["--update-sessions", "--yes", "--workspace", "/w"]);
    expect(updateSessionsArgs()).toEqual(["--update-sessions", "--yes"]);
    expect(updateSessionsArgs("/w")).not.toContain("--idle-for");
  });
});

describe("restartStartFailed", () => {
  it("matches sandy's relaunch-failure line only", () => {
    expect(restartStartFailed("[sandy] Restarting p-1a2b...\n[sandy]   --start failed for p-1a2b\n")).toBe(true);
    expect(restartStartFailed("[sandy] Docker is not installed or not in PATH.\n")).toBe(false);
    expect(restartStartFailed("[sandy]   --stop failed for p-1a2b\n")).toBe(false);
  });
});
