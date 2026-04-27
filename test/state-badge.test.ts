import { describe, it, expect } from "vitest";
import { deriveBadge, SandboxBadge } from "../src/state/badge";
import type { SandySandbox, SandyRunningContainer } from "../src/state/types";

const NOW = new Date("2026-04-27T12:00:00Z");

const sb = (overrides: Partial<SandySandbox> = {}): SandySandbox => ({
  name: "myproj-abc12345",
  path: "/Users/x/.sandy/sandboxes/myproj-abc12345",
  workspace_path: "/Users/x/dev/myproj",
  ...overrides,
});

const container = (sandbox: string): SandyRunningContainer => ({
  id: "deadbeef", sandbox, name: `sandy_${sandbox}_42`,
});

describe("deriveBadge", () => {
  describe("running", () => {
    it("wins over lock_held when a container exists for this sandbox", () => {
      const s = sb({ lock_held: true });
      expect(deriveBadge(s, [container("myproj-abc12345")], { now: NOW })).toBe("running");
    });

    it("wins over stale-by-time when a container exists", () => {
      const s = sb({ last_used_at: "2020-01-01T00:00:00Z" });
      expect(deriveBadge(s, [container("myproj-abc12345")], { now: NOW })).toBe("running");
    });

    it("does not match when running container is for a different sandbox", () => {
      const s = sb({ lock_held: false });
      expect(deriveBadge(s, [container("other-sandbox")], { now: NOW })).toBe("current");
    });
  });

  describe("locked", () => {
    it("returns 'locked' when lock_held=true and no running container", () => {
      const s = sb({ lock_held: true });
      expect(deriveBadge(s, [], { now: NOW })).toBe("locked");
    });

    it("returns 'locked' when running_containers is null (docker unreachable)", () => {
      const s = sb({ lock_held: true });
      expect(deriveBadge(s, null, { now: NOW })).toBe("locked");
    });
  });

  describe("stale", () => {
    it("returns 'stale' when last_used_at older than threshold", () => {
      const s = sb({ last_used_at: "2026-01-01T00:00:00Z" });  // > 30 days before NOW
      expect(deriveBadge(s, [], { now: NOW })).toBe("stale");
    });

    it("does NOT return 'stale' when last_used_at is recent", () => {
      const s = sb({ last_used_at: "2026-04-25T00:00:00Z" });  // 2 days before NOW
      expect(deriveBadge(s, [], { now: NOW })).toBe("current");
    });

    it("ignores invalid date strings (defensive — falls back to 'current')", () => {
      const s = sb({ last_used_at: "not-a-date" });
      expect(deriveBadge(s, [], { now: NOW })).toBe("current");
    });
  });

  describe("fresh", () => {
    it("returns 'fresh' when created recently AND never used", () => {
      const s = sb({ created_at: "2026-04-27T11:00:00Z" });  // 1 hour ago, no last_used_at
      expect(deriveBadge(s, [], { now: NOW })).toBe("fresh");
    });

    it("does NOT return 'fresh' when created recently BUT used (it's 'current' instead)", () => {
      const s = sb({
        created_at:   "2026-04-27T10:00:00Z",
        last_used_at: "2026-04-27T11:00:00Z",
      });
      expect(deriveBadge(s, [], { now: NOW })).toBe("current");
    });

    it("does NOT return 'fresh' when created days ago and never used", () => {
      const s = sb({ created_at: "2026-04-20T00:00:00Z" });  // 7 days ago
      expect(deriveBadge(s, [], { now: NOW })).toBe("current");
    });
  });

  describe("current (default)", () => {
    it("returns 'current' when nothing distinctive is true", () => {
      const s = sb({ last_used_at: "2026-04-26T00:00:00Z" });  // 1 day ago, normal
      expect(deriveBadge(s, [], { now: NOW })).toBe("current");
    });

    it("returns 'current' when no timestamps at all (older sandbox)", () => {
      const s = sb({});  // no created_at, no last_used_at, no lock
      expect(deriveBadge(s, [], { now: NOW })).toBe("current");
    });
  });
});
