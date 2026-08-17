import * as cp from "child_process";
import * as vscode from "vscode";
import type { SandyState } from "./types";
import { resolveSandyBinary } from "./sandyPath";
import { parseSandyJson } from "./parseJson";

// Polls `sandy --print-state` on a fixed cadence; emits change events when
// the state JSON differs from the previous poll. Tree provider subscribes
// to refresh itself when state changes.

export interface StateResolution {
  state?: SandyState;
  error?: string;
  fetched_at: Date;
}

export class StatePoller implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<StateResolution>();
  readonly onDidChange = this._onDidChange.event;

  private latest: StateResolution = { fetched_at: new Date(0) };
  private timer: NodeJS.Timeout | undefined;
  private inFlight = false;
  private cadenceMs: number | undefined;

  constructor(private readonly out?: vscode.OutputChannel) {}

  /**
   * Set the polling interval; undefined stops polling entirely. Called by
   * extension.ts whenever tree-view visibility or window focus changes (see
   * state/cadence.ts for the policy and the cost rationale). Speeding up —
   * including resuming from stopped — triggers an immediate refresh so the
   * tree is never stale right after the user brings the view back.
   */
  setCadence(ms: number | undefined): void {
    if (ms === this.cadenceMs) return;
    const prev = this.cadenceMs;
    this.cadenceMs = ms;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (ms === undefined) return;
    if (prev === undefined || ms < prev) void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, ms);
  }

  dispose(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this._onDidChange.dispose();
  }

  current(): StateResolution { return this.latest; }

  async refresh(): Promise<StateResolution> {
    if (this.inFlight) return this.latest;
    this.inFlight = true;
    try {
      const next = await this.invoke();
      const changed = !equalsSummary(this.latest.state, next.state) || (this.latest.error !== next.error);
      this.latest = next;
      if (changed) this._onDidChange.fire(next);
      return next;
    } finally {
      this.inFlight = false;
    }
  }

  private invoke(): Promise<StateResolution> {
    return new Promise<StateResolution>((resolve) => {
      const sandyBin = resolveSandyBinary();
      if (!sandyBin) {
        const fetched_at = new Date();
        const msg = "sandy not found (PATH or common install locations); set sandy.binaryPath in settings if installed elsewhere";
        this.out?.appendLine(`[${fetched_at.toISOString()}] state poll: ${msg}`);
        resolve({ error: msg, fetched_at });
        return;
      }
      // "light" asks sandy to skip the expensive installed_images section and
      // probe docker reachability with a single `docker ps` (9 docker spawns
      // → 1; rappdw/sandy#18). Current sandy ignores the extra arg, so this
      // is safe to pass unconditionally — the speedup activates when the
      // sandy-side change ships.
      cp.execFile(sandyBin, ["--print-state", "light"], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      }, (err, stdout) => {
        const fetched_at = new Date();
        if (err) {
          const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `sandy binary missing at ${sandyBin}`
            : (err.message || String(err));
          this.out?.appendLine(`[${fetched_at.toISOString()}] state poll failed: ${msg}`);
          resolve({ error: msg, fetched_at });
          return;
        }
        try {
          const state = parseSandyJson<SandyState>(stdout);
          resolve({ state, fetched_at });
        } catch (e: any) {
          const msg = `parse failed: ${e?.message ?? e}`;
          this.out?.appendLine(`[${fetched_at.toISOString()}] state poll ${msg}`);
          resolve({ error: msg, fetched_at });
        }
      });
    });
  }
}

// Coarse equality: only compares fields the tree view cares about. Avoids
// firing change events for irrelevant updates (e.g., size_bytes ticking).
function equalsSummary(a: SandyState | undefined, b: SandyState | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.docker_reachable !== b.docker_reachable) return false;
  if ((a.sandboxes?.length ?? 0) !== (b.sandboxes?.length ?? 0)) return false;
  if ((a.running_containers?.length ?? 0) !== (b.running_containers?.length ?? 0)) return false;
  // Per-sandbox lock + running state can change.
  for (let i = 0; i < a.sandboxes.length; i++) {
    const sa = a.sandboxes[i];
    const sb = b.sandboxes[i];
    if (sa.name !== sb.name) return false;
    if (!!sa.lock_held !== !!sb.lock_held) return false;
    // Tri-state (true/false/null) plus "absent" (undefined) on older sandy —
    // compare with ===, not !! coercion, which would collapse null and false
    // into the same falsy bucket and miss a dead-holder transition.
    if (sa.lock_holder_alive !== sb.lock_holder_alive) return false;
    if (sa.last_used_at !== sb.last_used_at) return false;
  }
  // Compare running_containers names by sandbox attribution.
  const aRun = new Set((a.running_containers ?? []).map(c => c.sandbox));
  const bRun = new Set((b.running_containers ?? []).map(c => c.sandbox));
  if (aRun.size !== bRun.size) return false;
  for (const s of aRun) if (!bRun.has(s)) return false;
  return true;
}
