import { describe, it, expect } from "vitest";
import { deriveBadge, daemonInfoFor, formatAge, findLongRunners, persistedSessionForWorkspace, SandboxBadge } from "../src/state/badge";
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
  describe("supervisor view (highest priority)", () => {
    it("returns 'running' when supervisor has the workspace, even if running_containers is empty", () => {
      const s = sb({ workspace_path: "/x/myproj", lock_held: true });
      const supervisorRunningWorkspaces = new Set(["/x/myproj"]);
      expect(deriveBadge(s, [], { now: NOW, supervisorRunningWorkspaces })).toBe("running");
    });

    it("returns 'running' when supervisor has the workspace, even if running_containers is null (docker unreachable)", () => {
      const s = sb({ workspace_path: "/x/myproj" });
      const supervisorRunningWorkspaces = new Set(["/x/myproj"]);
      expect(deriveBadge(s, null, { now: NOW, supervisorRunningWorkspaces })).toBe("running");
    });

    it("falls through to print-state derivation when supervisor doesn't have the workspace", () => {
      const s = sb({ workspace_path: "/x/myproj", lock_held: true });
      const supervisorRunningWorkspaces = new Set(["/different/workspace"]);
      expect(deriveBadge(s, [], { now: NOW, supervisorRunningWorkspaces })).toBe("locked");
    });

    it("ignores supervisor view when sandbox has no workspace_path (can't match)", () => {
      const s = sb({ workspace_path: undefined as unknown as string, lock_held: true });
      const supervisorRunningWorkspaces = new Set(["/some/path"]);
      expect(deriveBadge(s, [], { now: NOW, supervisorRunningWorkspaces })).toBe("locked");
    });
  });

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

    it("returns 'locked' when lock_holder_alive is true", () => {
      const s = sb({ lock_held: true, lock_holder_alive: true });
      expect(deriveBadge(s, [], { now: NOW })).toBe("locked");
    });

    it("returns 'locked' when lock_holder_alive is undefined (back-compat with older sandy)", () => {
      const s = sb({ lock_held: true, lock_holder_alive: undefined });
      expect(deriveBadge(s, [], { now: NOW })).toBe("locked");
    });

    it("returns 'locked' when lock_holder_alive is null", () => {
      const s = sb({ lock_held: true, lock_holder_alive: null });
      expect(deriveBadge(s, [], { now: NOW })).toBe("locked");
    });

    // A dead holder does NOT demote the badge. The badge describes the lock
    // FILE (held either way) and drives contextValue -> menu visibility, so
    // demoting would hide "Remove Lock" from exactly the case it exists for.
    // Liveness is surfaced as text (description/tooltip/modal) instead.
    it("still returns 'locked' when lock_holder_alive is false (recent last_used_at)", () => {
      const s = sb({ lock_held: true, lock_holder_alive: false, last_used_at: "2026-04-26T00:00:00Z" });  // 1 day ago
      expect(deriveBadge(s, [], { now: NOW })).toBe("locked");
    });

    it("still returns 'locked' when lock_holder_alive is false (very old last_used_at)", () => {
      const s = sb({ lock_held: true, lock_holder_alive: false, last_used_at: "2026-01-01T00:00:00Z" });  // > 30 days before NOW
      expect(deriveBadge(s, [], { now: NOW })).toBe("locked");
    });

    it("running container still wins over a dead lock", () => {
      const s = sb({ lock_held: true, lock_holder_alive: false });
      expect(deriveBadge(s, [container("myproj-abc12345")], { now: NOW })).toBe("running");
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

describe("daemonInfoFor", () => {
  it("returns attachedClients when daemon=true and attached_clients is a positive number", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "myproj-abc12345", daemon: true, attached_clients: 2 },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toEqual({ attachedClients: 2 });
  });

  it("returns attachedClients: 0 when daemon=true and attached_clients is 0", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "myproj-abc12345", daemon: true, attached_clients: 0 },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toEqual({ attachedClients: 0 });
  });

  it("returns attachedClients: null when attached_clients is explicitly null", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "myproj-abc12345", daemon: true, attached_clients: null },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toEqual({ attachedClients: null });
  });

  it("returns attachedClients: null when attached_clients is absent", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "myproj-abc12345", daemon: true },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toEqual({ attachedClients: null });
  });

  it("returns undefined when daemon is false", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "myproj-abc12345", daemon: false, attached_clients: 3 },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toBeUndefined();
  });

  it("returns undefined when daemon is absent (pre-1.1.0 sandy)", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "myproj-abc12345", attached_clients: 3 },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toBeUndefined();
  });

  it("returns undefined when no container matches the sandbox name", () => {
    const containers: SandyRunningContainer[] = [
      { id: "1", sandbox: "other-sandbox", daemon: true, attached_clients: 1 },
    ];
    expect(daemonInfoFor("myproj-abc12345", containers)).toBeUndefined();
  });

  it("returns undefined when runningContainers is null (docker unreachable)", () => {
    expect(daemonInfoFor("myproj-abc12345", null)).toBeUndefined();
  });

  it("returns undefined when runningContainers is empty", () => {
    expect(daemonInfoFor("myproj-abc12345", [])).toBeUndefined();
  });
});

describe("formatAge", () => {
  it("returns undefined for an unparseable date", () => {
    expect(formatAge("not-a-date", NOW)).toBeUndefined();
  });

  it("returns '<1m' for a future date (clock skew)", () => {
    const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    expect(formatAge(future, NOW)).toBe("<1m");
  });

  it("returns '<1m' for less than 60s ago", () => {
    const started = new Date(NOW.getTime() - 30_000).toISOString();
    expect(formatAge(started, NOW)).toBe("<1m");
  });

  it("returns '1m' at exactly the 60s boundary", () => {
    const started = new Date(NOW.getTime() - 60_000).toISOString();
    expect(formatAge(started, NOW)).toBe("1m");
  });

  it("returns minutes below the 60m boundary", () => {
    const started = new Date(NOW.getTime() - 59 * 60_000).toISOString();
    expect(formatAge(started, NOW)).toBe("59m");
  });

  it("returns '1h' at exactly the 60m boundary", () => {
    const started = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(formatAge(started, NOW)).toBe("1h");
  });

  it("returns hours below the 48h boundary", () => {
    const started = new Date(NOW.getTime() - 47 * 60 * 60_000).toISOString();
    expect(formatAge(started, NOW)).toBe("47h");
  });

  it("returns '2d' at exactly the 48h boundary", () => {
    const started = new Date(NOW.getTime() - 48 * 60 * 60_000).toISOString();
    expect(formatAge(started, NOW)).toBe("2d");
  });

  it("returns days for multi-day ages, floored", () => {
    const started = new Date(NOW.getTime() - 100 * 60 * 60_000).toISOString();
    expect(formatAge(started, NOW)).toBe("4d");
  });

  it("defaults `now` to the current time when omitted", () => {
    const started = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatAge(started)).toBe("5m");
  });
});

describe("persistedSessionForWorkspace", () => {
  it("returns undefined when runningContainers is null (docker unreachable)", () => {
    expect(persistedSessionForWorkspace(null, [sb()], "/Users/x/dev/myproj")).toBeUndefined();
  });

  it("returns undefined when runningContainers is empty", () => {
    expect(persistedSessionForWorkspace([], [sb()], "/Users/x/dev/myproj")).toBeUndefined();
  });

  it("returns the container when a daemon container's sandbox joins to the target workspace_path", () => {
    const c: SandyRunningContainer = { id: "1", sandbox: "myproj-abc12345", daemon: true, attached_clients: 0 };
    expect(persistedSessionForWorkspace([c], [sb()], "/Users/x/dev/myproj")).toBe(c);
  });

  it("returns undefined when the matching sandbox's workspace_path differs from the target", () => {
    const c: SandyRunningContainer = { id: "1", sandbox: "myproj-abc12345", daemon: true };
    expect(persistedSessionForWorkspace([c], [sb()], "/Users/x/dev/other")).toBeUndefined();
  });

  it("returns undefined when the container isn't a daemon session", () => {
    const c: SandyRunningContainer = { id: "1", sandbox: "myproj-abc12345", daemon: false };
    expect(persistedSessionForWorkspace([c], [sb()], "/Users/x/dev/myproj")).toBeUndefined();
  });

  it("returns undefined when daemon is absent (pre-1.1.0 sandy)", () => {
    const c: SandyRunningContainer = { id: "1", sandbox: "myproj-abc12345" };
    expect(persistedSessionForWorkspace([c], [sb()], "/Users/x/dev/myproj")).toBeUndefined();
  });

  it("returns undefined when no sandbox matches the container's sandbox name (join fails)", () => {
    const c: SandyRunningContainer = { id: "1", sandbox: "unknown-sandbox", daemon: true };
    expect(persistedSessionForWorkspace([c], [sb()], "/Users/x/dev/myproj")).toBeUndefined();
  });

  it("returns undefined when the matching sandbox has no workspace_path at all", () => {
    const orphan = sb({ name: "orphan-sandbox", workspace_path: undefined });
    const c: SandyRunningContainer = { id: "1", sandbox: "orphan-sandbox", daemon: true };
    expect(persistedSessionForWorkspace([c], [orphan], "/Users/x/dev/myproj")).toBeUndefined();
  });

  it("picks the right container among multiple", () => {
    const other = sb({ name: "other-sandbox", workspace_path: "/Users/x/dev/other" });
    const c1: SandyRunningContainer = { id: "1", sandbox: "myproj-abc12345", daemon: true };
    const c2: SandyRunningContainer = { id: "2", sandbox: "other-sandbox", daemon: true };
    expect(persistedSessionForWorkspace([c1, c2], [sb(), other], "/Users/x/dev/other")).toBe(c2);
  });
});

describe("findLongRunners", () => {
  const daemonContainer = (
    sandbox: string,
    startedAt: string | undefined,
    overrides: Partial<SandyRunningContainer> = {},
  ): SandyRunningContainer => ({
    id: "deadbeef", sandbox, name: `sandy_${sandbox}_42`, daemon: true, started_at: startedAt, ...overrides,
  });

  it("returns [] when containers is null (docker unreachable)", () => {
    expect(findLongRunners(null, [], 24, NOW)).toEqual([]);
  });

  it("excludes containers younger than the threshold", () => {
    const c = daemonContainer("myproj-abc12345", new Date(NOW.getTime() - 2 * 60 * 60_000).toISOString());
    expect(findLongRunners([c], [sb()], 24, NOW)).toEqual([]);
  });

  it("excludes a container exactly at the threshold (strictly greater-than)", () => {
    const c = daemonContainer("myproj-abc12345", new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString());
    expect(findLongRunners([c], [sb()], 24, NOW)).toEqual([]);
  });

  it("includes containers older than the threshold", () => {
    const c = daemonContainer("myproj-abc12345", new Date(NOW.getTime() - 30 * 60 * 60_000).toISOString());
    const result = findLongRunners([c], [sb()], 24, NOW);
    expect(result).toEqual([{ sandboxName: "myproj-abc12345", workspacePath: "/Users/x/dev/myproj", age: "30h" }]);
  });

  it("excludes non-daemon containers even if old", () => {
    const c = daemonContainer("myproj-abc12345", new Date(NOW.getTime() - 30 * 60 * 60_000).toISOString(), { daemon: false });
    expect(findLongRunners([c], [sb()], 24, NOW)).toEqual([]);
  });

  it("excludes containers with unparseable started_at", () => {
    const c = daemonContainer("myproj-abc12345", "not-a-date");
    expect(findLongRunners([c], [sb()], 24, NOW)).toEqual([]);
  });

  it("excludes containers with no started_at", () => {
    const c = daemonContainer("myproj-abc12345", undefined);
    expect(findLongRunners([c], [sb()], 24, NOW)).toEqual([]);
  });

  it("joins workspacePath by sandbox name; leaves it undefined when no sandbox matches", () => {
    const c = daemonContainer("unknown-sandbox", new Date(NOW.getTime() - 30 * 60 * 60_000).toISOString());
    const result = findLongRunners([c], [sb()], 24, NOW);
    expect(result).toEqual([{ sandboxName: "unknown-sandbox", workspacePath: undefined, age: "30h" }]);
  });

  it("returns multiple entries when multiple daemon containers exceed threshold", () => {
    const c1 = daemonContainer("myproj-abc12345", new Date(NOW.getTime() - 30 * 60 * 60_000).toISOString());
    const c2 = daemonContainer("other-sandbox", new Date(NOW.getTime() - 50 * 60 * 60_000).toISOString());
    const other = sb({ name: "other-sandbox", workspace_path: "/Users/x/dev/other" });
    const result = findLongRunners([c1, c2], [sb(), other], 24, NOW);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.sandboxName)).toEqual(["myproj-abc12345", "other-sandbox"]);
  });
});

