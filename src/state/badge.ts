// Pure logic: derive a state badge for a sandbox from --print-state data.
// Exported separately so it's unit-testable without vscode/node-pty.

import type { SandySandbox, SandyRunningContainer } from "./types";

export type SandboxBadge = "running" | "locked" | "stale" | "fresh" | "current";

const STALE_AFTER_DAYS = 30;
const FRESH_BEFORE_DAYS = 1;

export interface BadgeContext {
  now?: Date;  // injectable for tests
}

export function deriveBadge(
  sandbox: SandySandbox,
  runningContainers: SandyRunningContainer[] | null,
  ctx: BadgeContext = {},
): SandboxBadge {
  const now = ctx.now ?? new Date();

  // running: live container exists for this sandbox.
  // (running_containers is null when docker isn't reachable, in which case
  // we can't tell — fall through to file-state-derived classification.)
  if (runningContainers && runningContainers.some(c => c.sandbox === sandbox.name)) {
    return "running";
  }

  // locked: lock file held but no running container. Stale lock or pre-launch
  // setup window. The host's stale-lock sweep will clean dead-PID locks at
  // launch time, but for display we just show the locked state.
  if (sandbox.lock_held === true) return "locked";

  // stale: hasn't been touched in a long time.
  if (sandbox.last_used_at) {
    const days = daysBetween(parseIsoDate(sandbox.last_used_at), now);
    if (days != null && days > STALE_AFTER_DAYS) return "stale";
  }

  // fresh: created very recently AND never used.
  if (sandbox.created_at && !sandbox.last_used_at) {
    const days = daysBetween(parseIsoDate(sandbox.created_at), now);
    if (days != null && days <= FRESH_BEFORE_DAYS) return "fresh";
  }

  return "current";
}

function parseIsoDate(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(then: Date | null, now: Date): number | null {
  if (!then) return null;
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24);
}
