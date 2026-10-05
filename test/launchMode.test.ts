import { describe, it, expect } from "vitest";
import { shouldUseDaemon, LaunchModeInputs } from "../src/daemon/launchMode";

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
