import { describe, it, expect } from "vitest";
import { shouldUseDaemon, liveLockIsOwnStart, OWN_START_WINDOW_MS, LaunchModeInputs } from "../src/daemon/launchMode";

// The daemon path requires every input to agree; each is an independent veto.
// Pinned here because the decision drives which lifecycle a launch takes, and
// getting it wrong is invisible until a session behaves unexpectedly.
const ok: LaunchModeInputs = {
  forceLegacy: false,
  launchCommand: "",
  persistSessions: true,
  daemonCapable: true,
  hasSandyBinary: true,
};

describe("shouldUseDaemon", () => {
  it("uses the daemon path when every input agrees", () => {
    expect(shouldUseDaemon(ok)).toBe(true);
  });

  it("forceLegacy vetoes even when everything else is green", () => {
    expect(shouldUseDaemon({ ...ok, forceLegacy: true })).toBe(false);
  });

  it("any launchCommand vetoes (sandy-ui#24)", () => {
    expect(shouldUseDaemon({ ...ok, launchCommand: "sandy --new" })).toBe(false);
  });

  it("treats a whitespace-only launchCommand as unset", () => {
    expect(shouldUseDaemon({ ...ok, launchCommand: "   " })).toBe(true);
  });

  it("persistSessions off vetoes", () => {
    expect(shouldUseDaemon({ ...ok, persistSessions: false })).toBe(false);
  });

  it("no daemon capability vetoes (pre-1.1.0 sandy)", () => {
    expect(shouldUseDaemon({ ...ok, daemonCapable: false })).toBe(false);
  });

  it("no resolvable sandy binary vetoes", () => {
    expect(shouldUseDaemon({ ...ok, hasSandyBinary: false })).toBe(false);
  });

  it("each veto is independent — every single-veto combination is legacy", () => {
    const vetoes: Partial<LaunchModeInputs>[] = [
      { forceLegacy: true },
      { launchCommand: "x" },
      { persistSessions: false },
      { daemonCapable: false },
      { hasSandyBinary: false },
    ];
    for (const v of vetoes) {
      expect(shouldUseDaemon({ ...ok, ...v })).toBe(false);
    }
  });
});

// sandy-ui#50: a foreground retry after this window's own --start timed out
// finds that --start's background process still holding the lock. It must get
// the truthful "still starting" prompt, not "running outside this window".
describe("liveLockIsOwnStart", () => {
  const t0 = 1_000_000;
  it("is true only for a forceLegacy retry soon after a --start failure here", () => {
    expect(liveLockIsOwnStart(true, { code: 8, at: t0 }, t0 + 5_000)).toBe(true);
    expect(liveLockIsOwnStart(false, { code: 8, at: t0 }, t0 + 5_000)).toBe(false);
    expect(liveLockIsOwnStart(true, undefined, t0)).toBe(false);
  });
  it("expires, and ignores a failure time in the future (clock change)", () => {
    expect(liveLockIsOwnStart(true, { code: 8, at: t0 }, t0 + OWN_START_WINDOW_MS)).toBe(false);
    expect(liveLockIsOwnStart(true, { code: 8, at: t0 }, t0 - 1)).toBe(false);
  });
});
