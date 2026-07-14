// TypeScript shapes for `sandy --print-state`. See SPEC_INTROSPECTION.md
// in the sandy repo for the authoritative contract. Optional where the spec
// allows additive change.

import type { SandyMeta } from "../schema/types";

export interface SandySandbox {
  name: string;
  path: string;
  // Absent until sandy emits it natively (rappdw/sandy#19); today it's
  // best-effort recovered from WORKSPACE.json by state/enrich.ts and can
  // legitimately stay undefined for orphan/legacy sandboxes. Typing it
  // required was a lie the tree/badge code already defended against.
  workspace_path?: string;
  created_version?: string;
  last_used_version?: string;
  created_at?: string;
  last_used_at?: string;
  agent?: string;
  size_bytes?: number;
  lock_held?: boolean;
  lock_holder_pid?: number | null;
  compat_warning?: string | null;
}

export interface SandyApproval {
  workspace_hash: string;
  workspace_path_hint?: string;
  approved_keys_sha256?: string;
  approved_at?: string;
}

export interface SandyRunningContainer {
  id: string;
  name?: string;
  sandbox: string;
  started_at?: string;
  agent?: string;
  // sandy 1.1.0+ daemon-mode additions (rappdw/sandy-ui#12 frozen contract).
  // Absent on pre-1.1.0 sandy — feature-detect, don't assume.
  daemon?: boolean;               // true = attachable sandy daemon session
  attached_clients?: number | null;  // live tmux client count; null for non-daemon
}

export interface SandyState {
  schema_version: number;
  sandy?: SandyMeta;
  sandy_home?: string;
  installed_images?: unknown[];
  sandboxes: SandySandbox[];
  approvals: SandyApproval[];
  running_containers: SandyRunningContainer[] | null;  // null when docker_reachable=false
  docker_reachable?: boolean;
  // sandy 1.1.0+: orphaned sandy_* networks, or null when Docker unreachable.
  orphan_networks?: number | null;
}
