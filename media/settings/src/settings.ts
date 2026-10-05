// Webview-side settings form. Project (workspace) and Global (home) scope
// tabs, schema-driven form fields, scope-aware secrets, persists in-progress
// edits per-scope across hide/show via VSCode webview state.
//
// Mirror the host-side message contracts in src/settings/webviewPanel.ts.
// Kept structural (no shared file) — host is Node, webview is browser.

export {}; // mark as module so local types don't leak into global scope

import { agentBoxes, agentComboValue, agentTokens, boolChecked, boolEncoding, boolUnrecognized, displayValue, baselineValue, enumOptions, pickChanged, applySavedAck, ingestHostScope, type FormRow } from "./saveRules";

type Scope = "home" | "workspace";

interface FieldDef {
  key: string;
  type: "string" | "path" | "int" | "bool" | "enum" | "agent_combo" | "secret";
  tier: "home" | "workspace" | "secrets";
  privileged?: boolean;
  pattern?: string;
  min?: number;
  max?: number;
  options?: string[];
  default?: unknown;
  description?: string;
  stability?: string;   // "stable" | "experimental" | "deprecated" (sandy --print-schema)
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
  clearPending: string[];   // secrets marked "clear on save" (names only)
  misplaced: string[];      // non-secret keys stored in .secrets by older builds
  exists: boolean;
  available: boolean;
}

interface PersistedState {
  schema: Schema | null;
  activeScope: Scope;
  scopes: { home: ScopeState; workspace: ScopeState };
  // "sparse": `form` holds only unsaved edits (0.8.3+). Absent = an older
  // build's full snapshot of every field, which must NOT be restored — see the
  // restore block.
  formModel?: "sparse";
}

interface SchemaSource {
  kind: "cache" | "fresh" | "fallback";
  error?: string;
}

type FromHost =
  | { type: "schema"; schema: Schema; source: SchemaSource; scopes: { home: ScopeFromHost; workspace: ScopeFromHost | null }; readOnly?: boolean }
  | { type: "saveFailed"; scope: Scope }
  | { type: "saved"; scope: Scope; values?: Record<string, string>; secretsPresent?: Record<string, boolean>; misplaced?: string[] };

interface ScopeFromHost {
  configPath: string;
  secretsPath: string;
  values: Record<string, string>;
  exists: boolean;
  secretsPresent: Record<string, boolean>;
  misplaced?: string[];
}

type ToHost =
  | { type: "ready" }
  | { type: "save"; scope: Scope; values: Record<string, string>; clearSecrets?: string[] }
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
  let schemaSource: SchemaSource | null = null;
  let activeScope: Scope = "workspace";  // default to project; falls back to home if no workspace
  // Values captured at save-click, committed on the host's "saved" ack.
  // Read-only until the host says otherwise. 0.8.3 ships with Settings Save
  // turned off (rappdw/sandy-ui#53) and the host refuses saves regardless; this
  // only makes the panel say so instead of offering controls that do nothing.
  let readOnly = true;
  // `reverted`: Revert was clicked while this save was in flight — the user
  // gave up on their edits, so nothing is pinned (see persistFormFromDom).
  let pendingSave: { scope: Scope; values: Record<string, string>; clearSecrets: string[]; reverted?: boolean } | null = null;
  const emptyScope = (): ScopeState => ({
    configPath: "", secretsPath: "",
    values: {}, initial: {}, form: {},
    secretsPresent: {}, clearPending: [], misplaced: [],
    exists: false, available: false,
  });
  const scopes: Record<Scope, ScopeState> = {
    home:      { ...emptyScope(), available: true },
    workspace: { ...emptyScope(), available: false },
  };

  // ---- Loading state ---------------------------------------------------------
  // Shown until the first "schema" message arrives (sandy-ui#25b) — up to
  // ~15s against a wedged sandy/docker otherwise leaves a blank panel with
  // no feedback. renderActive() (called once "schema" lands) does its own
  // form.replaceChildren(), so this node is discarded automatically.
  function showSchemaLoading(): void {
    const form = $("form");
    form.replaceChildren();
    const p = document.createElement("p");
    p.className = "hint";
    p.id = "schema-loading";
    p.textContent = "Loading sandy schema…";
    form.appendChild(p);
  }

  function renderSchemaWarn(): void {
    const warn = $("schema-warn");
    if (schemaSource?.kind === "fallback") {
      warn.hidden = false;
      warn.textContent = `Showing the bundled mock schema — sandy was unreachable (${schemaSource.error ?? "unknown error"}). Fields may not match your sandy version; saves still write real files.`;
    } else {
      warn.hidden = true;
    }
  }

  // ---- Hide/show restoration ------------------------------------------------
  const persisted = vscode.getState<PersistedState>();
  if (persisted) {
    schema = persisted.schema;
    activeScope = persisted.activeScope || "workspace";
    Object.assign(scopes.home, persisted.scopes?.home ?? {});
    Object.assign(scopes.workspace, persisted.scopes?.workspace ?? {});
    // Older builds persisted a snapshot of EVERY field as "drafts". Restoring
    // one would replay stale values over anything changed in the file since,
    // so it is discarded. The cost is losing unsaved edits once, on upgrade.
    if (persisted.formModel !== "sparse") {
      scopes.home.form = {}; scopes.home.initial = {};
      scopes.workspace.form = {}; scopes.workspace.initial = {};
    }
  }
  // A restored session that already has a schema skips straight to the form
  // — only a cold boot (no getState yet) shows the loading hint.
  if (schema) renderActive();
  else showSchemaLoading();

  // ---- Host messages -------------------------------------------------------
  function ingestScope(target: ScopeState, src: ScopeFromHost): void {
    target.configPath = src.configPath;
    target.secretsPath = src.secretsPath;
    target.exists = !!src.exists;
    target.available = true;
    // s.form holds ONLY the user's unsaved edits; untouched keys display
    // straight from s.values. The old model copied every file value into
    // form, so after a hide/show (or any edit) a stale snapshot was compared
    // against the current file — overwriting changes made in an editor.
    Object.assign(target, ingestHostScope(target, src));
    target.initial = target.initial ?? {};
  }

  window.addEventListener("message", (e: MessageEvent) => {
    const m = e.data as FromHost;
    if (m.type === "schema") {
      readOnly = m.readOnly !== false;
      schema = m.schema;
      schemaSource = m.source;
      ingestScope(scopes.home, m.scopes.home);
      if (m.scopes.workspace) {
        ingestScope(scopes.workspace, m.scopes.workspace);
      } else {
        scopes.workspace.available = false;
        if (activeScope === "workspace") activeScope = "home";
      }
      saveState();
      renderTabs();
      renderSchemaWarn();
      renderActive();
    } else if (m.type === "saveFailed") {
      // Nothing was written; the edits are still in the form. Allow a retry.
      pendingSave = null;
    } else if (m.type === "saved") {
      const scope = m.scope || activeScope;
      // Compare against the payload captured at save-click, NOT a fresh
      // collect(): if the user switched tabs meanwhile, collect() would read
      // the OTHER scope's DOM.
      if (scope === activeScope) persistFormFromDom();
      const sent = pendingSave !== null && pendingSave.scope === scope
        ? pendingSave : { scope, values: {}, clearSecrets: [] };
      pendingSave = null;
      const isSecret = (k: string) => schema?.fields.find(f => f.key === k)?.type === "secret";
      Object.assign(scopes[scope], applySavedAck(scopes[scope], sent, m, isSecret));
      scopes[scope].initial = {};
      saveState();
      if (scope === activeScope) renderActive();
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
  // What a control will ACTUALLY hold when rendered from the file and left
  // untouched. The browser rewrites some values as they're set — a number input
  // blanks anything it can't parse (`"4"` with quotes, `4 # comment`), a text
  // input strips line breaks (CRLF files). Comparing against the raw file value
  // made an untouched field look changed, and the save rewrote or DELETED it.
  // So measure: render a throwaway control the same way and read it back.
  function domBaseline(f: FieldDef, fileValue: string | undefined): string {
    const pure = baselineValue(f, fileValue);
    if (f.type === "bool" || f.type === "enum" || f.type === "agent_combo" || f.type === "secret") return pure;
    const probe = document.createElement("input");
    probe.type = f.type === "int" ? "number" : "text";
    probe.value = pure;
    return probe.value;
  }

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
      // Deprecated keys: sandy is retiring them, and some (SANDY_RELAY) it now
      // refuses at ANY value — offering a control for one invites the user to
      // write a value that breaks every launch. Hide them unless the user's file
      // already sets one; then show it as plain text so it can be cleared.
      const inFile = s.values[f.key] !== undefined;
      if (f.stability === "deprecated" && !inFile) continue;
      const eff: FieldDef = f.stability === "deprecated"
        ? { ...f, type: "string", description: `Deprecated: current sandy may refuse this key. Clear it to remove it from the file.${f.description ? " " + f.description : ""}` }
        // sandy 2.x lists no choices for SANDY_AGENT: a checkbox group with no
        // boxes showed nothing and couldn't be edited. Comma-separated text.
        : f.type === "agent_combo" && !(f.options?.length)
          ? { ...f, type: "string" }
          : f;
      // A secret's control shows only a draft typed this session (kept in
      // memory, never persisted) — never a default, which Save would send.
      const shownRaw = eff.type === "secret" ? s.form[f.key] : displayValue(eff, s.form[f.key] ?? s.values[f.key]);
      const shown = shownRaw == null ? undefined : String(shownRaw);
      const baseline = domBaseline(eff, s.values[f.key]);

      // One field must never take down the form. Before this guard, a single
      // throw here (an unrecognized type) silently dropped every later field.
      try {
        const row = renderField(eff, shown, s, baseline);
        if (s.misplaced.includes(f.key)) {
          const d = document.createElement("p");
          d.className = "desc";
          d.textContent = `Stored in ${s.secretsPath || ".secrets"} by an older sandy-ui, where it overrides the config file. Saving this setting moves it to the config file.`;
          row.appendChild(d);
        }
        form.appendChild(row);
      } catch (e) {
        const err = e as { message?: string };
        fail(`renderField(${f.key})`, e);
        const row = document.createElement("div");
        row.className = "row";
        row.textContent = `${f.key}: couldn't render this setting (${err?.message ?? String(e)}). See the "Sandy Settings" output channel.`;
        form.appendChild(row);
      }
    }
    applyReadOnly(s);
  }

  function applyReadOnly(s: ScopeState): void {
    ($("save") as HTMLButtonElement).disabled = readOnly;
    ($("revert") as HTMLButtonElement).disabled = readOnly;
    let note = document.getElementById("readonly-note");
    if (!readOnly) { note?.remove(); return; }
    for (const el of Array.from($("form").querySelectorAll("input, select, textarea, button"))) {
      (el as HTMLInputElement).disabled = true;
    }
    if (!note) {
      note = document.createElement("p");
      note.id = "readonly-note";
      note.className = "warn";
      $("form").before(note);
    }
    note.textContent =
      "Editing is turned off in this version of sandy-ui. Saving from this panel could put some " +
      "settings in the wrong file, so it's disabled until a fix ships. To change a setting now, edit " +
      `${s.configPath || "the config file"} directly.`;
  }

  function renderField(f: FieldDef, value: string | undefined, s: ScopeState, baseline: string): HTMLElement {
    const secretsPresent = s.secretsPresent || {};
    const row = document.createElement("div");
    row.className = "row" + (f.privileged ? " privileged" : "");

    const label = document.createElement("label");
    label.textContent = f.key;
    label.setAttribute("for", `f-${f.key}`);
    row.appendChild(label);

    let input: HTMLElement & { dataset: DOMStringMap };
    let note: HTMLElement | null = null;   // shown under the control

    switch (f.type) {
      case "string":
      case "path": {   // sandy 2.x: a filesystem path, edited as text
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
        i.checked = boolChecked(f, value);
        // The control writes this key's own spelling (1/0 or true/false).
        const enc = boolEncoding(f);
        i.dataset.on = enc.on;
        i.dataset.off = enc.off;
        const raw = s.values[f.key];
        if (boolUnrecognized(f, raw)) {
          note = document.createElement("p");
          note.className = "desc";
          note.textContent = `The file has "${raw}", which sandy doesn't read as on for this setting (it expects ${enc.on} or ${enc.off}). Toggle and save to rewrite it.`;
        }
        input = i;
        break;
      }
      case "enum": {
        // An unset enum selects "(sandy default)" rather than whichever option
        // happens to be listed first — that guess is how a never-touched
        // SANDY_CROSS_SESSION_INBOUND would have been saved as "accept".
        const i = document.createElement("select");
        const shown = value ?? "";
        for (const o of enumOptions(f, shown)) {
          const opt = document.createElement("option");
          opt.value = o.value; opt.textContent = o.label;
          if (o.value === shown) opt.selected = true;
          i.appendChild(opt);
        }
        input = i;
        break;
      }
      case "agent_combo": {
        const i = document.createElement("div");
        i.className = "checkbox-group";
        // The stored order is sandy's (first = primary agent); collectRows
        // writes it back through agentComboValue.
        const selected = new Set(agentTokens(value));
        i.dataset.stored = value ?? "";
        for (const box of agentBoxes(f.options || [], value)) {
          const wrap = document.createElement("label");
          wrap.className = "inline";
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.value = box.value;
          cb.checked = selected.has(box.value);
          wrap.appendChild(cb);
          wrap.appendChild(document.createTextNode(" " + box.value + (box.listed ? "" : " (not a listed agent)")));
          i.appendChild(wrap);
        }
        if (agentTokens(value).length > 1) {
          note = document.createElement("p");
          note.className = "desc";
          note.textContent = `Order: ${agentTokens(value).join(", ")} — the first is the primary agent. Newly checked agents are added at the end.`;
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
        i.value = value ?? "";
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

        // Clear affordance (sandy-ui#25a) — only rendered when a value is
        // already stored; a not-set secret has nothing to clear. Toggles
        // row.dataset.clearSecret rather than clearing immediately so the
        // user can undo before Save actually deletes the key.
        if (isSet) {
          const clearBtn = document.createElement("button");
          clearBtn.type = "button";
          clearBtn.className = "clear-secret";
          const setClearing = (clearing: boolean) => {
            if (clearing) {
              row.dataset.clearSecret = f.key;
              badge.className = "badge badge-clearing";
              badge.textContent = "will clear on save";
              i.value = "";
              i.disabled = true;
              i.placeholder = "(will be cleared)";
              clearBtn.textContent = "undo";
            } else {
              delete row.dataset.clearSecret;
              badge.className = "badge badge-set";
              badge.textContent = "✓ set";
              i.disabled = false;
              i.placeholder = "(leave blank to keep current value)";
              clearBtn.textContent = "clear";
            }
          };
          // The mark survives re-render (a save ack, a tab switch, hide/show).
          setClearing(s.clearPending.includes(f.key));
          clearBtn.addEventListener("click", () => {
            setClearing(row.dataset.clearSecret !== f.key);
            persistFormFromDom();
          });
          wrap.appendChild(clearBtn);
        }

        row.appendChild(wrap);
        if (f.description) {
          const d = document.createElement("p"); d.className = "desc"; d.textContent = f.description;
          row.appendChild(d);
        }
        i.dataset.key = f.key;
        i.dataset.type = f.type;
        return row;
      }
      default: {
        // Compile time: every type FieldDef declares has a case above, or this
        // assignment fails to typecheck. Run time: the schema comes from
        // whatever sandy is installed, and a newer sandy can emit a type this
        // build has never seen. sandy 2.x added `path`, and with no default
        // here the first such field threw and aborted the whole form, silently
        // hiding 46 of 62 settings. Edit unknown types as plain text instead.
        const _exhaustive: never = f.type; void _exhaustive;
        const unknownType = String((f as { type: unknown }).type);
        const i = document.createElement("input");
        i.type = "text";
        i.value = value ?? "";
        i.title = `Unrecognized field type "${unknownType}" — edited as plain text.`;
        log(`settings: field ${f.key} has unrecognized type "${unknownType}"; rendering as text`);
        input = i;
        break;
      }
    }

    input.id = `f-${f.key}`;
    input.dataset.key = f.key;
    input.dataset.type = f.type;
    // What this control serializes to if left untouched, computed from the
    // FILE's value (not drafts). Save sends a key only when it differs.
    input.dataset.baseline = baseline;
    row.appendChild(input);
    if (note) row.appendChild(note);

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

  // Every rendered row's current value, with the baseline it was rendered
  // against (undefined for secrets, which are only ever sent when typed).
  function collectRows(): FormRow[] {
    const rows: FormRow[] = [];
    for (const row of Array.from($("form").children)) {
      const group = row.querySelector(".checkbox-group") as HTMLElement | null;
      if (group) {
        const labelEl = row.querySelector("label");
        const k = group.dataset.key ?? labelEl?.textContent?.trim().split(/\s/)[0];
        if (!k) continue;
        const vals = Array.from(group.querySelectorAll("input:checked")).map(c => (c as HTMLInputElement).value);
        // "" when nothing is checked → host clears the key (unchecking every
        // agent previously kept the old SANDY_AGENT — review finding B2).
        rows.push({ key: k, value: agentComboValue(group.dataset.stored ?? "", vals), baseline: group.dataset.baseline });
        continue;
      }
      const keyEl = row.querySelector("[data-key]") as (HTMLInputElement | HTMLSelectElement | null);
      if (!keyEl) continue;
      const k = keyEl.dataset.key!;
      const t = keyEl.dataset.type!;
      if (t === "bool") {
        // Each key's own spelling — see boolEncoding in saveRules.ts.
        const on = keyEl.dataset.on ?? "1", off = keyEl.dataset.off ?? "0";
        rows.push({ key: k, value: (keyEl as HTMLInputElement).checked ? on : off, baseline: keyEl.dataset.baseline });
      } else if (t === "secret") {
        const v = (keyEl as HTMLInputElement).value;
        if (v) rows.push({ key: k, value: v, baseline: undefined });  // skip blank — keeps existing
      } else {
        // Include empty values: "" tells the host to CLEAR the key. Dropping
        // empties meant the host's merge silently resurrected the old value
        // (review finding B2).
        rows.push({ key: k, value: keyEl.value, baseline: keyEl.dataset.baseline });
      }
    }
    return rows;
  }

  // What Save sends: only keys whose value differs from what the file would
  // display. The host merges into the existing file and keeps every key it
  // isn't sent, so skipping an untouched key is always safe — and writing every
  // rendered key was not (see saveRules.ts for what it broke).
  function collectChanged(): Record<string, string> {
    return pickChanged(collectRows());
  }

  // Rows currently toggled to "will clear on save". Excludes any row where
  // the user also typed a value — typed value wins. In practice this can't
  // happen since the input is disabled while a row is marked cleared, but
  // filtered defensively anyway.
  function collectClearSecrets(): string[] {
    const out: string[] = [];
    for (const row of Array.from($("form").children)) {
      const key = (row as HTMLElement).dataset.clearSecret;
      if (!key) continue;
      const keyEl = row.querySelector("[data-key]") as HTMLInputElement | null;
      if (keyEl && keyEl.value) continue;
      out.push(key);
    }
    return out;
  }

  function persistFormFromDom(): void {
    if (!schema) return;
    // Edits only — see ingestScope. While a save of this scope is in flight,
    // keys it sent stay pinned: an edit back to the old file value must
    // survive the ack, which moves the baseline to the sent value.
    const pinned = pendingSave?.scope === activeScope && !pendingSave.reverted
      ? new Set(Object.keys(pendingSave.values)) : undefined;
    scopes[activeScope].form = pickChanged(collectRows(), pinned);
    scopes[activeScope].clearPending = collectClearSecrets();
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
        .filter(f => f.type === "secret")
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
      schema, activeScope, formModel: "sparse",
      scopes: { home: sanitizeScope(scopes.home), workspace: sanitizeScope(scopes.workspace) },
    });
  }

  // ---- Save / Revert -------------------------------------------------------
  $("save").addEventListener("click", () => {
    if (pendingSave) return;   // one save in flight at a time
    persistFormFromDom();
    const clearSecrets = collectClearSecrets();
    const values = collectChanged();
    pendingSave = { scope: activeScope, values, clearSecrets };
    vscode.postMessage({ type: "save", scope: activeScope, values, clearSecrets } satisfies ToHost);
  });
  $("revert").addEventListener("click", () => {
    scopes[activeScope].form = {};   // discard unsaved edits; display falls back to the file
    scopes[activeScope].clearPending = [];
    if (pendingSave?.scope === activeScope) pendingSave.reverted = true;
    saveState();
    renderActive();
  });

  vscode.postMessage({ type: "ready" } satisfies ToHost);
})();
