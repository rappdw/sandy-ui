import { describe, it, expect } from "vitest";
import {
  ATTACH_EXIT,
  STOP_EXIT,
  classifyAttachExit,
  classifyDaemonAttachExit,
  startArgs,
  attachArgs,
  stopArgs,
  pruneOrphansArgs,
  hasDaemonCapability,
} from "../src/daemon/contract";

describe("classifyAttachExit", () => {
  it("0 → ended", () => {
    expect(classifyAttachExit(0)).toBe("ended");
    expect(classifyAttachExit(ATTACH_EXIT.SESSION_ENDED)).toBe("ended");
  });

  it("3 → detached", () => {
    expect(classifyAttachExit(3)).toBe("detached");
    expect(classifyAttachExit(ATTACH_EXIT.DETACHED)).toBe("detached");
  });

  it("4 → no-session", () => {
    expect(classifyAttachExit(4)).toBe("no-session");
    expect(classifyAttachExit(ATTACH_EXIT.NO_SESSION)).toBe("no-session");
  });

  it("5 → failed", () => {
    expect(classifyAttachExit(5)).toBe("failed");
    expect(classifyAttachExit(ATTACH_EXIT.FAILED)).toBe("failed");
  });

  it("unknown codes → failed", () => {
    expect(classifyAttachExit(1)).toBe("failed");
    expect(classifyAttachExit(137)).toBe("failed");
  });

  it("undefined/null (killed by signal, no exit code observed) → failed", () => {
    expect(classifyAttachExit(undefined)).toBe("failed");
    expect(classifyAttachExit(null)).toBe("failed");
  });
});

describe("classifyDaemonAttachExit", () => {
  it("detachRequested=true wins over every (code, signal) combination", () => {
    expect(classifyDaemonAttachExit(0, undefined, true)).toBe("detached");
    expect(classifyDaemonAttachExit(0, null, true)).toBe("detached");
    expect(classifyDaemonAttachExit(0, 0, true)).toBe("detached");
    expect(classifyDaemonAttachExit(0, 15, true)).toBe("detached");
    expect(classifyDaemonAttachExit(3, undefined, true)).toBe("detached");
    expect(classifyDaemonAttachExit(4, undefined, true)).toBe("detached");
    expect(classifyDaemonAttachExit(5, undefined, true)).toBe("detached");
    expect(classifyDaemonAttachExit(5, 9, true)).toBe("detached");
  });

  it("signal set with code 0 → detached (the core regression: without the fix this would be 'ended')", () => {
    expect(classifyDaemonAttachExit(0, 15, false)).toBe("detached"); // SIGTERM
    expect(classifyDaemonAttachExit(0, 9, false)).toBe("detached");  // SIGKILL
  });

  it("signal set with code 5 → detached", () => {
    expect(classifyDaemonAttachExit(5, 15, false)).toBe("detached");
    expect(classifyDaemonAttachExit(5, 9, false)).toBe("detached");
  });

  it("signal 0 falls through to the code table", () => {
    expect(classifyDaemonAttachExit(0, 0, false)).toBe("ended");
    expect(classifyDaemonAttachExit(3, 0, false)).toBe("detached");
    expect(classifyDaemonAttachExit(4, 0, false)).toBe("no-session");
    expect(classifyDaemonAttachExit(5, 0, false)).toBe("failed");
  });

  it("signal undefined falls through to the code table", () => {
    expect(classifyDaemonAttachExit(0, undefined, false)).toBe("ended");
    expect(classifyDaemonAttachExit(3, undefined, false)).toBe("detached");
    expect(classifyDaemonAttachExit(4, undefined, false)).toBe("no-session");
    expect(classifyDaemonAttachExit(5, undefined, false)).toBe("failed");
  });

  it("signal null falls through to the code table", () => {
    expect(classifyDaemonAttachExit(0, null, false)).toBe("ended");
    expect(classifyDaemonAttachExit(3, null, false)).toBe("detached");
    expect(classifyDaemonAttachExit(4, null, false)).toBe("no-session");
    expect(classifyDaemonAttachExit(5, null, false)).toBe("failed");
  });

  it("detachRequested=false + no signal → identical results to classifyAttachExit", () => {
    for (const code of [0, 3, 4, 5, undefined, null, 99]) {
      expect(classifyDaemonAttachExit(code as any, undefined, false)).toBe(classifyAttachExit(code as any));
      expect(classifyDaemonAttachExit(code as any, null, false)).toBe(classifyAttachExit(code as any));
    }
  });
});

describe("STOP_EXIT", () => {
  it("matches the frozen contract table", () => {
    expect(STOP_EXIT).toEqual({ STOPPED: 0, NO_SESSION: 4, FAILED: 5 });
  });
});

describe("args builders", () => {
  it("startArgs includes --start and --workspace in order", () => {
    expect(startArgs("/ws/foo")).toEqual(["--start", "--workspace", "/ws/foo"]);
  });

  it("attachArgs includes --attach and --workspace in order", () => {
    expect(attachArgs("/ws/foo")).toEqual(["--attach", "--workspace", "/ws/foo"]);
  });

  it("stopArgs includes --stop and --workspace in order", () => {
    expect(stopArgs("/ws/foo")).toEqual(["--stop", "--workspace", "/ws/foo"]);
  });

  it("pruneOrphansArgs is just --prune-orphans", () => {
    expect(pruneOrphansArgs()).toEqual(["--prune-orphans"]);
  });
});

describe("hasDaemonCapability", () => {
  it("undefined schema → false", () => {
    expect(hasDaemonCapability(undefined)).toBe(false);
  });

  it("missing capabilities → false", () => {
    expect(hasDaemonCapability({})).toBe(false);
  });

  it("capabilities.daemonMode false → false", () => {
    expect(hasDaemonCapability({ capabilities: { daemonMode: false } })).toBe(false);
  });

  it("capabilities.daemonMode true → true", () => {
    expect(hasDaemonCapability({ capabilities: { daemonMode: true } })).toBe(true);
  });
});
