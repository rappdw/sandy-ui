// TypeScript shapes for `sandy --print-state`. See SPEC_INTROSPECTION.md
// in the sandy repo for the authoritative contract. Optional where the spec
// allows additive change.

import type { SandyMeta } from "../schema/types";

export interface SandySandbox {
  name: string;
  path: string;
  workspace_path: string;
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
}
