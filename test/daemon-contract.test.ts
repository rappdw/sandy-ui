import { describe, it, expect } from "vitest";
import {
  ATTACH_EXIT,
  STOP_EXIT,
  classifyAttachExit,
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
