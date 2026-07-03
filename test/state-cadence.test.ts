import { describe, it, expect } from "vitest";
import { pollCadence, ACTIVE_POLL_MS, BACKGROUND_POLL_MS } from "../src/state/cadence";

describe("pollCadence", () => {
  it("polls fast when the Sandy view is visible in a focused window", () => {
    expect(pollCadence(true, true)).toBe(ACTIVE_POLL_MS);
  });

  it("slows down when the view is visible but the window is unfocused", () => {
    expect(pollCadence(true, false)).toBe(BACKGROUND_POLL_MS);
  });

  it("stops entirely when the view is hidden, regardless of focus", () => {
    expect(pollCadence(false, true)).toBeUndefined();
    expect(pollCadence(false, false)).toBeUndefined();
  });

  it("active cadence is meaningfully faster than background", () => {
    expect(ACTIVE_POLL_MS).toBeLessThan(BACKGROUND_POLL_MS);
  });
});
