// Pure logic: derive a state badge for a sandbox from --print-state data.
// Exported separately so it's unit-testable without vscode/node-pty.

import type { SandySandbox, SandyRunningContainer } from "./types";

export type SandboxBadge = "running" | "locked" | "stale" | "fresh" | "current";

const STALE_AFTER_DAYS = 30;
const FRESH_BEFORE_DAYS = 1;

export interface BadgeContext {
  now?: Date;  // injectable for tests
  // Workspace paths the supervisor has live sessions for. These outrank
  // sandy's running_containers report — if WE spawned a sandy and have a
  // PTY for it, the badge should say "running" even if sandy --print-state
  // hasn't caught up yet (or if sandy's reporting is buggy and the
  // container info doesn't match the sandbox name).
  supervisorRunningWorkspaces?: ReadonlySet<string>;
}

export function deriveBadge(
  sandbox: SandySandbox,
  runningContainers: SandyRunningContainer[] | null,
  ctx: BadgeContext = {},
): SandboxBadge {
  const now = ctx.now ?? new Date();

  // running: prefer the supervisor's view (we know we have a live PTY for
  // this workspace), fall back to sandy --print-state's running_containers.
  if (sandbox.workspace_path && ctx.supervisorRunningWorkspaces?.has(sandbox.workspace_path)) {
    return "running";
  }
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

export interface DaemonInfo { attachedClients: number | null; startedAt?: string }

/** The daemon container for a sandbox, or undefined when none / not daemon. */
export function daemonInfoFor(
  sandboxName: string,
  runningContainers: SandyRunningContainer[] | null,
): DaemonInfo | undefined {
  const c = runningContainers?.find(c => c.sandbox === sandboxName && c.daemon === true);
  if (!c) return undefined;
  return { attachedClients: c.attached_clients ?? null, startedAt: c.started_at };
}

function parseIsoDate(s: string): Date | null {
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(then: Date | null, now: Date): number | null {
  if (!then) return null;
  return (now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24);
}

/**
 * Human-readable session age ("<1m" / "5m" / "3h" / "2d") from an ISO
 * started_at timestamp. Unparseable input returns undefined (defensive —
 * sandy's daemon fields are feature-detected, not guaranteed well-formed).
 * A future timestamp (clock skew) is indistinguishable from "just started"
 * for display purposes, so it collapses to the same "<1m" floor as a
 * genuinely fresh session rather than showing a negative age.
 */
export function formatAge(startedAtIso: string, now?: Date): string | undefined {
  const start = parseIsoDate(startedAtIso);
  if (!start) return undefined;
  const nowD = now ?? new Date();
  const ms = nowD.getTime() - start.getTime();
  if (ms < 60_000) return "<1m";
  const minutes = Math.floor(ms / (60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ms / (60 * 60_000));
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(ms / (24 * 60 * 60_000));
  return `${days}d`;
}

export interface LongRunner { sandboxName: string; workspacePath?: string; age: string }

/**
 * Daemon (persisted) sessions whose age exceeds thresholdHours. Used by the
 * once-per-window "long-running session" nudge (rappdw/sandy-ui#26). Caller
 * is responsible for the thresholdHours<=0 "disabled" short-circuit — this
 * function has no opinion on 0 (it would just mean "everything qualifies").
 */
export function findLongRunners(
  containers: SandyRunningContainer[] | null,
  sandboxes: SandySandbox[],
  thresholdHours: number,
  now?: Date,
): LongRunner[] {
  if (!containers) return [];
  const nowD = now ?? new Date();
  const thresholdMs = thresholdHours * 60 * 60 * 1000;
  const results: LongRunner[] = [];
  for (const c of containers) {
    if (c.daemon !== true || !c.started_at) continue;
    const start = parseIsoDate(c.started_at);
    if (!start) continue;
    const ageMs = nowD.getTime() - start.getTime();
    if (ageMs <= thresholdMs) continue;
    const age = formatAge(c.started_at, nowD);
    if (!age) continue;
    const workspacePath = sandboxes.find(s => s.name === c.sandbox)?.workspace_path;
    results.push({ sandboxName: c.sandbox, workspacePath, age });
  }
  return results;
}
