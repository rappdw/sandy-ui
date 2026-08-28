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
  hasDaemonCapability, classifyStartExit, START_EXIT, startFailureMessage } from "../src/daemon/contract";

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

// --start's exit table (rappdw/sandy#221, sandy >= 1.7). These drive which
// explanation the user gets on a failed launch, so a wrong mapping means a
// confidently wrong message — the specific failure that motivated adding it
// (telling the user "daemon mode can't prompt" when sandy HAD prompted and
// they declined).
describe("classifyStartExit", () => {
  it("maps the known table", () => {
    expect(classifyStartExit(0)).toBe("ready");
    expect(classifyStartExit(6)).toBe("refused");
    expect(classifyStartExit(7)).toBe("crash-loop");
    expect(classifyStartExit(8)).toBe("timeout");
  });

  it("treats pre-#221 sandy's generic 1 as failed, not as any specific cause", () => {
    expect(classifyStartExit(1)).toBe("failed");
  });

  it("treats unknown/absent codes as failed", () => {
    for (const c of [2, 3, 4, 5, 9, 99, -1, undefined, null]) {
      expect(classifyStartExit(c as number | undefined | null)).toBe("failed");
    }
  });

  it("genuinely diverges from the --attach table for shared codes", () => {
    // 3/4/5 mean something for --attach but nothing for --start. Prove the two
    // classifiers disagree rather than just asserting one of them, so a future
    // "simplification" that reuses classifyAttachExit here fails loudly.
    // 3 and 4 are the divergent pair. 5 means "failed" in BOTH tables, so it
    // proves nothing about divergence — assert it start-side only.
    for (const c of [3, 4]) {
      expect(classifyStartExit(c)).toBe("failed");
      expect(classifyAttachExit(c)).not.toBe("failed");
    }
    expect(classifyStartExit(5)).toBe("failed");
  });

  it("START_EXIT constants match the documented codes", () => {
    expect(START_EXIT).toEqual({ READY: 0, REFUSED: 6, CRASH_LOOP: 7, TIMEOUT: 8 });
  });
});

// The wording IS the feature here — this branching exists because the previous
// single message asserted a cause ("daemon mode can't answer prompts") that
// upstream had made false. So pin the claims, not just the selection.
describe("startFailureMessage", () => {
  it("picks a distinct message per outcome", () => {
    const msgs = [1, 6, 7, 8].map(startFailureMessage);
    expect(new Set(msgs).size).toBe(4);
  });

  it("never claims daemon mode cannot prompt — upstream fixed that (sandy#221)", () => {
    for (const c of [1, 6, 7, 8, undefined, null]) {
      expect(startFailureMessage(c as number | undefined | null).toLowerCase())
        .not.toContain("can't answer prompts");
    }
  });

  it("refused does NOT promise that retrying will re-ask", () => {
    // Exit 6 also covers hard refusals that are errors, not questions (a new
    // escaping symlink since the last approval). Promising another prompt
    // there sends the user to a button that reproduces the same failure.
    const m = startFailureMessage(6).toLowerCase();
    expect(m).not.toContain("will ask again");
    expect(m).toContain("approval was not granted");
    expect(m).toContain("terminal");   // point at sandy's own reason + fix
  });

  it("crash-loop and timeout name where the relevant log tail is", () => {
    expect(startFailureMessage(7).toLowerCase()).toContain("container log tail");
    expect(startFailureMessage(8).toLowerCase()).toContain("supervisor log tail");
  });

  it("includes the exit code, and degrades readably when there isn't one", () => {
    expect(startFailureMessage(7)).toContain("exit 7");
    expect(startFailureMessage(undefined)).toContain("exit unknown");
  });
});
