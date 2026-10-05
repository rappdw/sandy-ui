import { describe, it, expect } from "vitest";
import { newRestartWatch, observeRestart, updateSessionsArgs, restartStartFailed, RestartWatch } from "../src/daemon/restart";

const feed = (obs: Array<{ updated_at?: string | null } | undefined>) => {
  let w: RestartWatch = newRestartWatch();
  const out: boolean[] = [];
  for (const o of obs) { const r = observeRestart(w, o); w = r.watch; out.push(r.restarted); }
  return out;
};

describe("observeRestart (sandy --update-sessions restart detection)", () => {
  it("container gone, then back: restarted", () => {
    expect(feed([undefined, undefined, { updated_at: "2026-10-05T03:00:00Z" }])).toEqual([false, false, true]);
  });
  it("old container still listed at first, then a new updated_at: restarted", () => {
    expect(feed([{ updated_at: null }, { updated_at: null }, { updated_at: "2026-10-05T03:00:00Z" }])).toEqual([false, false, true]);
    expect(feed([{ updated_at: "A" }, { updated_at: "B" }])).toEqual([false, true]);
  });
  it("same container still there: not restarted", () => {
    expect(feed([{ updated_at: "A" }, { updated_at: "A" }, { updated_at: "A" }])).toEqual([false, false, false]);
  });
  it("never comes back (stopped for good): not restarted", () => {
    expect(feed([undefined, undefined, undefined])).toEqual([false, false, false]);
  });
  it("gone then back even with updated_at null (restarted by hand): restarted", () => {
    expect(feed([{ updated_at: null }, undefined, { updated_at: null }])).toEqual([false, false, true]);
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
