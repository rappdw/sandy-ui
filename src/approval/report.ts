// `sandy --approvals --workspace P` (sandy >= 2.7.0, #296): what each launch
// approval gate would decide, judged by the launch's own code, read-only.
// Pure — parsing and wording only, so it can be unit-tested; running sandy is
// in approvals.ts. Contract: sandy's SPEC_INTROSPECTION.md, "--approvals".
//
// sandy-ui used to show its own approval modal and then launch with
// SANDY_AUTO_APPROVE_PRIVILEGED=1. Decision C (ROADMAP_1.0.md): the modal is
// now a read-only PREVIEW and sandy asks in the terminal, which records the
// answer itself. The preview still shows values, which sandy's own prompt
// doesn't (it prints key names only).

export type GateName = "passive_privileged" | "symlinks" | "dockerfile";
export type GateStatus = "approved" | "pending" | "changed" | "refused" | "not_applicable";

export interface ApprovalGate {
  gate: GateName | string;
  status: GateStatus | string;
  approved_at?: string | null;
  if_unanswered?: string | null;
  keys?: string[];
  sources?: string[];
  symlinks?: string[];
  new?: string[];
  dockerfile?: string;
  context_files?: string[];
  session_created?: boolean;
}

export interface ApprovalsReport {
  workspace?: string;
  complete: boolean;
  error?: string | null;
  unresolved: string[];
  gates: ApprovalGate[];
}

/** Narrow an already-parsed JSON value to a usable report, or undefined. */
export function asApprovalsReport(v: unknown): ApprovalsReport | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as Partial<ApprovalsReport>;
  if (typeof r.complete !== "boolean") return undefined;
  return {
    workspace: typeof r.workspace === "string" ? r.workspace : undefined,
    complete: r.complete,
    error: typeof r.error === "string" ? r.error : null,
    unresolved: Array.isArray(r.unresolved) ? r.unresolved.filter((g): g is string => typeof g === "string") : [],
    gates: Array.isArray(r.gates) ? r.gates.filter((g): g is ApprovalGate => !!g && typeof g === "object" && typeof (g as ApprovalGate).gate === "string") : [],
  };
}

const gate = (r: ApprovalsReport, name: GateName) => r.gates.find(g => g.gate === name);
const unresolved = (r: ApprovalsReport, name: GateName) => r.complete && r.unresolved.includes(name);
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];

/** A value from the workspace's files, for showing next to a key name. */
export interface KeyValueSource { value?: string; file?: string; secret: boolean }

/** Values that look like credentials are masked in the preview. */
export function looksSecret(key: string): boolean {
  return /(^|_)(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)$/.test(key);
}

export interface ApprovalPreview {
  header: string;
  subtext: string;
  body: string;
  /** sandy will refuse the launch whatever the user answers. */
  willRefuse: boolean;
}

/**
 * The preview to show before launching, or undefined when nothing needs it:
 * no report, an incomplete one (sandy then stops the launch with its own
 * message), or nothing unresolved.
 */
export function buildPreview(r: ApprovalsReport | undefined, values: (key: string) => KeyValueSource): ApprovalPreview | undefined {
  if (!r || !r.complete || r.unresolved.length === 0) return undefined;
  const sections: string[] = [];

  const sym = gate(r, "symlinks");
  const willRefuse = unresolved(r, "symlinks") && sym?.status === "refused";
  if (willRefuse) {
    const fresh = strings(sym?.new);
    sections.push(
      "SYMLINKS — sandy will refuse to start",
      "These symlinks point outside the workspace and aren't on its approved list. No prompt can approve them;",
      "the terminal will show sandy's message and how to approve them.",
      "",
      ...(fresh.length ? fresh : ["(sandy didn't list them)"]).map(s => `  ${s}`),
    );
  }

  const keys = gate(r, "passive_privileged");
  if (unresolved(r, "passive_privileged") && keys) {
    if (sections.length) sections.push("");
    sections.push(
      keys.status === "changed"
        ? `PRIVILEGED SETTINGS — changed since you approved them${keys.approved_at ? ` (${keys.approved_at})` : ""}`
        : "PRIVILEGED SETTINGS — not approved yet",
      "Set in this workspace. Sandy will ask in the terminal; if you say no, it starts without them.",
      "",
    );
    const names = strings(keys.keys);
    for (const k of names) {
      const v = values(k);
      if (v.value === undefined) sections.push(`  ${k}  (value not found in .sandy/config or .sandy/.secrets)`);
      else if (v.secret) sections.push(`  ${k}=••••••••  (hidden; set in ${v.file ?? ".sandy"})`);
      else sections.push(`  ${k}=${v.value}`);
    }
    if (names.length === 0) sections.push("  (sandy didn't list the keys)");
  }

  const df = gate(r, "dockerfile");
  if (unresolved(r, "dockerfile") && df) {
    if (sections.length) sections.push("");
    sections.push(
      df.status === "changed"
        ? `PROJECT DOCKERFILE — changed since you approved it${df.approved_at ? ` (${df.approved_at})` : ""}`
        : "PROJECT DOCKERFILE — not approved yet",
      "Sandy will ask in the terminal before building it; if you say no, the session uses the base image.",
      ...(df.session_created ? ["Note: a sandy session created this .sandy/ directory, not you."] : []),
      "",
      `  ${df.dockerfile ?? ".sandy/Dockerfile"}`,
      ...strings(df.context_files).map(f => `    build context: ${f}`),
    );
  }

  if (sections.length === 0) return undefined;   // an unresolved gate this build doesn't know
  return {
    header: willRefuse ? "Sandy will refuse to start this workspace" : "Sandy will ask for approval in the terminal",
    subtext: willRefuse
      ? "Review what sandy found. Continue to see sandy's message in the terminal, or cancel."
      : "This workspace asks for things sandy won't allow without your OK. Review them here — sandy's own prompt shows names only — then answer sandy in the terminal.",
    body: sections.join("\n"),
    willRefuse,
  };
}

/**
 * After a session started: what it is running WITHOUT, because a gate was
 * still unresolved (the user declined, or nobody answered). Empty when it got
 * everything. Symlinks aren't listed: an unresolved symlink gate refuses the
 * launch, so a started session can't have one.
 */
export function startedWithout(r: ApprovalsReport | undefined): string[] {
  if (!r || !r.complete) return [];
  const out: string[] = [];
  const keys = gate(r, "passive_privileged");
  if (unresolved(r, "passive_privileged") && keys) {
    const names = strings(keys.keys);
    out.push(names.length ? `privileged settings ${names.join(", ")}` : "the workspace's privileged settings");
  }
  if (unresolved(r, "dockerfile")) out.push("the project Dockerfile (running the base image)");
  return out;
}

/** The refused symlinks, when that is why a launch was refused. */
export function refusedSymlinks(r: ApprovalsReport | undefined): string[] {
  if (!r || !r.complete) return [];
  const sym = gate(r, "symlinks");
  return sym?.status === "refused" ? strings(sym.new) : [];
}
