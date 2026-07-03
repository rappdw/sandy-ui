// Webview-side settings form. Project (workspace) and Global (home) scope
// tabs, schema-driven form fields, scope-aware secrets, persists in-progress
// edits per-scope across hide/show via VSCode webview state.
//
// Mirror the host-side message contracts in src/settings/webviewPanel.ts.
// Kept structural (no shared file) — host is Node, webview is browser.

export {}; // mark as module so local types don't leak into global scope

type Scope = "home" | "workspace";

interface FieldDef {
  key: string;
  type: "string" | "int" | "bool" | "enum" | "agent_combo" | "secret";
  tier: "home" | "workspace" | "secrets";
  privileged?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: unknown;
  description?: string;
}

interface Schema {
  schema_version: number;
  sandy_version: string;
  fields: FieldDef[];
}

interface ScopeState {
  configPath: string;
  secretsPath: string;
  values: Record<string, string>;
  initial: Record<string, string>;
  form: Record<string, string>;
  secretsPresent: Record<string, boolean>;
  exists: boolean;
  available: boolean;
}

interface PersistedState {
  schema: Schema | null;
  activeScope: Scope;
  scopes: { home: ScopeState; workspace: ScopeState };
}

type FromHost =
  | { type: "schema"; schema: Schema; scopes: { home: ScopeFromHost; workspace: ScopeFromHost | null } }
  | { type: "saved"; scope: Scope };

interface ScopeFromHost {
  configPath: string;
  secretsPath: string;
  values: Record<string, string>;
  exists: boolean;
  secretsPresent: Record<string, boolean>;
}

type ToHost =
  | { type: "ready" }
  | { type: "save"; scope: Scope; values: Record<string, string> }
  | { type: "log"; level: "info" | "error"; msg: string };

(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id: string): HTMLElement => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`element #${id} missing from settings webview HTML`);
    return el;
  };

  // Surface webview-side errors to the host's Sandy Settings output channel.
  const log = (msg: string): void => {
    try { vscode.postMessage({ type: "log", level: "info", msg } satisfies ToHost); }
    catch { /* swallow */ }
  };
  const fail = (where: string, e: unknown): void => {
    const err = e as { message?: string; stack?: string } | undefined;
    const msg = `${where}: ${err?.message ?? String(e)}\n${err?.stack ?? ""}`;
    try { vscode.postMessage({ type: "log", level: "error", msg } satisfies ToHost); }
    catch { /* swallow */ }
  };
  void log; // referenced indirectly via fail; silence unused-var warning
  window.addEventListener("error", (ev) => fail("window.error", ev.error || ev.message));
  window.addEventListener("unhandledrejection", (ev) => fail("unhandledrejection", ev.reason));

  // ---- State ---------------------------------------------------------------
  let schema: Schema | null = null;
  let activeScope: Scope = "workspace";  // default to project; falls back to home if no workspace
  // Values captured at save-click, committed on the host's "saved" ack.
  let pendingSave: { scope: Scope; values: Record<string, string> } | null = null;
  const emptyScope = (): ScopeState => ({
    configPath: "", secretsPath: "",
    values: {}, initial: {}, form: {},
    secretsPresent: {},
    exists: false, available: false,
  });
  const scopes: Record<Scope, ScopeState> = {
    home:      { ...emptyScope(), available: true },
    workspace: { ...emptyScope(), available: false },
  };

  // ---- Hide/show restoration ------------------------------------------------
  const persisted = vscode.getState<PersistedState>();
  if (persisted) {
    schema = persisted.schema;
    activeScope = persisted.activeScope || "workspace";
    Object.assign(scopes.home, persisted.scopes?.home ?? {});
    Object.assign(scopes.workspace, persisted.scopes?.workspace ?? {});
    if (schema) renderActive();
  }

  // ---- Host messages -------------------------------------------------------
  function ingestScope(target: ScopeState, src: ScopeFromHost): void {
    target.configPath = src.configPath;
    target.secretsPath = src.secretsPath;
    target.values = src.values || {};
    target.exists = !!src.exists;
    target.secretsPresent = src.secretsPresent || {};
    target.available = true;
    if (!target.initial || Object.keys(target.initial).length === 0) target.initial = { ...target.values };
    if (!target.form    || Object.keys(target.form).length    === 0) target.form    = { ...target.values };
  }

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as FromHost;
    if (m.type === "schema") {
      schema = m.schema;
      ingestScope(scopes.home, m.scopes.home);
      if (m.scopes.workspace) {
        ingestScope(scopes.workspace, m.scopes.workspace);
      } else {
        scopes.workspace.available = false;
        if (activeScope === "workspace") activeScope = "home";
      }
      saveState();
      renderTabs();
      renderActive();
    } else if (m.type === "saved") {
      const scope = m.scope || activeScope;
      // Use the payload captured at save-click, NOT a fresh collect(): the
      // ack is async, and if the user switched tabs in between, collect()
      // would read the OTHER scope's DOM into this scope's baseline.
      const v = pendingSave && pendingSave.scope === scope ? pendingSave.values : collect();
      pendingSave = null;
      scopes[scope].initial = { ...v };
      scopes[scope].form    = { ...v };
      // After save, any non-blank secret value in the form is now stored.
      for (const f of (schema?.fields ?? [])) {
        if ((f.type === "secret" || f.tier === "secrets") && v[f.key]) {
          scopes[scope].secretsPresent[f.key] = true;
        }
      }
      saveState();
      renderActive();  // refresh badges
    }
  });

  // ---- Tab handling --------------------------------------------------------
  function renderTabs(): void {
    const tWs = $("tab-workspace");
    const tHm = $("tab-home");
    tWs.classList.toggle("active",  activeScope === "workspace");
    tHm.classList.toggle("active",  activeScope === "home");
    tWs.classList.toggle("disabled", !scopes.workspace.available);
    tWs.title = scopes.workspace.available
      ? "Project-scoped config (./.sandy/config in this workspace)"
      : "No workspace folder open";
  }

  $("tab-workspace").addEventListener("click", () => {
    if (!scopes.workspace.available) return;
    persistFormFromDom();
    activeScope = "workspace";
    saveState();
    renderTabs();
    renderActive();
  });
  $("tab-home").addEventListener("click", () => {
    persistFormFromDom();
    activeScope = "home";
    saveState();
    renderTabs();
    renderActive();
  });

  // ---- Render active scope -------------------------------------------------
  function renderActive(): void {
    if (!schema) return;
    const s = scopes[activeScope];
    $("scope-hint").textContent = `Editing ${s.configPath}` + (s.exists ? "" : " (will be created on save)");
    const warn = $("scope-warn");
    if (activeScope === "workspace") {
      warn.hidden = false;
      warn.innerHTML = "⚠ <strong>Privileged keys</strong> saved here trigger a passive-privileged approval prompt the next time sandy launches. <strong>Secrets</strong> saved here go to <code>.sandy/.secrets</code> in this workspace — make sure that path is in <code>.gitignore</code> before adding API keys.";
    } else {
      warn.hidden = true;
    }

    const form = $("form");
    form.replaceChildren();
    for (const f of schema.fields) {
      // Show every field in both scopes. Privileged keys saved in workspace
      // scope trigger the passive-privileged approval flow on next launch;
      // privileged keys saved in home scope are user-set so no approval is
      // needed. The yellow border + workspace-tab warning banner do the
      // visual differentiation.
      form.appendChild(renderField(f, s.form[f.key] ?? (f.default as string | undefined), s.secretsPresent));
    }
  }

  function renderField(f: FieldDef, value: string | undefined, secretsPresent: Record<string, boolean>): HTMLElement {
    secretsPresent = secretsPresent || {};
    const row = document.createElement("div");
    row.className = "row" + (f.privileged ? " privileged" : "");

    const label = document.createElement("label");
    label.textContent = f.key;
    label.setAttribute("for", `f-${f.key}`);
    row.appendChild(label);

    let input: HTMLElement & { dataset: DOMStringMap };

    switch (f.type) {
      case "string": {
        const i = document.createElement("input");
        i.type = "text";
        i.value = value ?? "";
        if (f.pattern) i.pattern = f.pattern;
        i.addEventListener("input", () => validatePattern(i, f.pattern));
        validatePattern(i, f.pattern);
        input = i;
        break;
      }
      case "int": {
        const i = document.createElement("input");
        i.type = "number";
        i.value = value ?? "";
        if (f.min != null) i.min = String(f.min);
        if (f.max != null) i.max = String(f.max);
        input = i;
        break;
      }
      case "bool": {
        const i = document.createElement("input");
        i.type = "checkbox";
        i.checked = value === ("true" as unknown as string) || value === "1" || (value as unknown) === true;
        input = i;
        break;
      }
      case "enum": {
        const i = document.createElement("select");
        for (const opt of f.options || []) {
          const o = document.createElement("option");
          o.value = opt; o.textContent = opt;
          if (String(value) === opt) o.selected = true;
          i.appendChild(o);
        }
        input = i;
        break;
      }
      case "agent_combo": {
        const i = document.createElement("div");
        i.className = "checkbox-group";
        const selected = new Set((value || "").split(",").filter(Boolean));
        for (const opt of f.options || []) {
          const wrap = document.createElement("label");
          wrap.className = "inline";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = opt;
          cb.checked = selected.has(opt);
          wrap.appendChild(cb);
          wrap.appendChild(document.createTextNode(" " + opt));
          i.appendChild(wrap);
        }
        input = i;
        break;
      }
      case "secret": {
        const isSet = !!secretsPresent[f.key];
        const badge = document.createElement("span");
        badge.className = "badge " + (isSet ? "badge-set" : "badge-unset");
        badge.textContent = isSet ? "✓ set" : "not set";
        label.appendChild(document.createTextNode(" "));
        label.appendChild(badge);

        const i = document.createElement("input");
        i.type = "password";
        i.placeholder = isSet ? "(leave blank to keep current value)" : "(enter to set)";
        i.value = "";
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "reveal";
        reveal.textContent = "👁";
        reveal.addEventListener("click", () => {
          i.type = i.type === "password" ? "text" : "password";
        });
        const wrap = document.createElement("div");
        wrap.className = "secret-wrap";
        wrap.appendChild(i);
        wrap.appendChild(reveal);
        row.appendChild(wrap);
        if (f.description) {
          const d = document.createElement("p"); d.className = "desc"; d.textContent = f.description;
          row.appendChild(d);
        }
        i.dataset.key = f.key;
        i.dataset.type = f.type;
        return row;
      }
    }

    input.id = `f-${f.key}`;
    input.dataset.key = f.key;
    input.dataset.type = f.type;
    row.appendChild(input);

    if (f.description) {
      const d = document.createElement("p"); d.className = "desc"; d.textContent = f.description;
      row.appendChild(d);
    }
    return row;
  }

  function validatePattern(input: HTMLInputElement, pattern: string | undefined): void {
    if (!pattern) return;
    const re = new RegExp(pattern);
    input.classList.toggle("invalid", input.value.length > 0 && !re.test(input.value));
  }

  function collect(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of Array.from($("form").children)) {
      const groupKey = row.querySelector(".checkbox-group");
      if (groupKey) {
        const labelEl = row.querySelector("label");
        if (!labelEl?.textContent) continue;
        const k = labelEl.textContent.trim().split(/\s/)[0];
        const vals = Array.from(groupKey.querySelectorAll("input:checked")).map(c => (c as HTMLInputElement).value);
        // "" when nothing is checked → host clears the key (unchecking every
        // agent previously kept the old SANDY_AGENT — review finding B2).
        out[k] = vals.join(",");
        continue;
      }
      const keyEl = row.querySelector("[data-key]") as (HTMLInputElement | HTMLSelectElement | null);
      if (!keyEl) continue;
      const k = keyEl.dataset.key!;
      const t = keyEl.dataset.type!;
      if (t === "bool") {
        // "true"/"false" — sandy's bash tests literal `= "true"` and its node
        // paths test `!== 'false'`; the old "1"/"0" encoding matched NEITHER,
        // so unchecking SANDY_SKIP_PERMISSIONS left the bypass active (review
        // finding B1).
        out[k] = (keyEl as HTMLInputElement).checked ? "true" : "false";
      } else if (t === "secret") {
        const v = (keyEl as HTMLInputElement).value;
        if (v) out[k] = v;  // skip blank — keeps existing
      } else {
        // Include empty values: "" tells the host to CLEAR the key. Dropping
        // empties meant the host's merge silently resurrected the old value
        // (review finding B2).
        out[k] = keyEl.value;
      }
    }
    return out;
  }

  function persistFormFromDom(): void {
    if (!schema) return;
    scopes[activeScope].form = collect();
    saveState();
  }

  // Bound ONCE — renderActive() used to re-add this listener on every render,
  // accumulating duplicate handlers (review finding B13).
  $("form").addEventListener("input", persistFormFromDom);

  function saveState(): void {
    // Never persist typed-but-unsaved SECRET values through webview state —
    // setState lands in VSCode's workspace storage in plaintext (review
    // finding S2). Hide/show loses an unsaved secret entry; acceptable.
    const secretKeys = new Set(
      (schema?.fields ?? [])
        .filter(f => f.type === "secret" || f.tier === "secrets")
        .map(f => f.key),
    );
    const stripSecrets = (r: Record<string, string>): Record<string, string> => {
      if (secretKeys.size === 0) return r;
      const o = { ...r };
      for (const k of secretKeys) delete o[k];
      return o;
    };
    const sanitizeScope = (s: ScopeState): ScopeState => ({ ...s, form: stripSecrets(s.form) });
    vscode.setState<PersistedState>({
      schema, activeScope,
      scopes: { home: sanitizeScope(scopes.home), workspace: sanitizeScope(scopes.workspace) },
    });
  }

  // ---- Save / Revert -------------------------------------------------------
  $("save").addEventListener("click", () => {
    persistFormFromDom();
    const values = collect();
    pendingSave = { scope: activeScope, values };
    vscode.postMessage({ type: "save", scope: activeScope, values } satisfies ToHost);
  });
  $("revert").addEventListener("click", () => {
    scopes[activeScope].form = { ...scopes[activeScope].initial };
    saveState();
    renderActive();
  });

  vscode.postMessage({ type: "ready" } satisfies ToHost);
})();
