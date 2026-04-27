(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  // Surface webview-side errors to the host's Sandy Settings output channel.
  // Without this, `saveState()` and friends throw silently and the form just
  // appears empty / clicks appear inert.
  const log  = (msg) => { try { vscode.postMessage({ type: "log", level: "info",  msg: String(msg) }); } catch {} };
  const fail = (where, e) => { try { vscode.postMessage({ type: "log", level: "error", msg: `${where}: ${e?.message ?? e}\n${e?.stack ?? ""}` }); } catch {} };
  window.addEventListener("error", (ev) => fail("window.error", ev.error || ev.message));
  window.addEventListener("unhandledrejection", (ev) => fail("unhandledrejection", ev.reason));

  // Per-scope state. Each scope tracks its own config + secrets independently
  // so switching tabs doesn't lose in-progress edits in the other scope.
  let schema = null;
  let activeScope = "workspace";  // default to project; falls back to home if no workspace open
  const scopes = {
    home: {
      configPath: "", secretsPath: "",
      values: {}, initial: {}, form: {},
      secretsPresent: {},
      exists: false, available: true,
    },
    workspace: {
      configPath: "", secretsPath: "",
      values: {}, initial: {}, form: {},
      secretsPresent: {},
      exists: false, available: false,
    },
  };

  // ---- Hide/show restoration -----------------------------------------------
  const persisted = vscode.getState();
  if (persisted) {
    schema      = persisted.schema;
    activeScope = persisted.activeScope || "workspace";
    Object.assign(scopes.home,      persisted.scopes?.home      || {});
    Object.assign(scopes.workspace, persisted.scopes?.workspace || {});
    if (schema) renderActive();
  }

  // ---- Host messages -------------------------------------------------------
  function ingestScope(target, src) {
    target.configPath     = src.configPath;
    target.secretsPath    = src.secretsPath;
    target.values         = src.values || {};
    target.exists         = !!src.exists;
    target.secretsPresent = src.secretsPresent || {};
    target.available      = true;
    if (!target.initial || Object.keys(target.initial).length === 0) target.initial = { ...target.values };
    if (!target.form    || Object.keys(target.form).length    === 0) target.form    = { ...target.values };
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
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
      const v = collect();
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
  function renderTabs() {
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
    persistFormFromDom();        // capture current edits before switching away
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
  function renderActive() {
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
      // Privileged keys still only make sense in workspace scope.
      if (activeScope === "home" && f.privileged) continue;
      form.appendChild(renderField(f, s.form[f.key] ?? f.default, s.secretsPresent));
    }
    bindFormChanges();
  }

  function renderField(f, value, secretsPresent) {
    secretsPresent = secretsPresent || {};
    const row = document.createElement("div");
    row.className = "row" + (f.privileged ? " privileged" : "");

    const label = document.createElement("label");
    label.textContent = f.key;
    label.setAttribute("for", `f-${f.key}`);
    row.appendChild(label);

    let input;
    switch (f.type) {
      case "string": {
        input = document.createElement("input");
        input.type = "text";
        input.value = value ?? "";
        if (f.pattern) input.pattern = f.pattern;
        input.addEventListener("input", () => validatePattern(input, f.pattern));
        validatePattern(input, f.pattern);
        break;
      }
      case "int": {
        input = document.createElement("input");
        input.type = "number";
        input.value = value ?? "";
        if (f.min != null) input.min = String(f.min);
        if (f.max != null) input.max = String(f.max);
        break;
      }
      case "bool": {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = value === true || value === "1" || value === "true";
        break;
      }
      case "enum": {
        input = document.createElement("select");
        for (const opt of f.options || []) {
          const o = document.createElement("option");
          o.value = opt; o.textContent = opt;
          if (String(value) === opt) o.selected = true;
          input.appendChild(o);
        }
        break;
      }
      case "agent_combo": {
        input = document.createElement("div");
        input.className = "checkbox-group";
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
          input.appendChild(wrap);
        }
        break;
      }
      case "secret": {
        const isSet = !!secretsPresent[f.key];
        const badge = document.createElement("span");
        badge.className = "badge " + (isSet ? "badge-set" : "badge-unset");
        badge.textContent = isSet ? "✓ set" : "not set";
        label.appendChild(document.createTextNode(" "));
        label.appendChild(badge);

        input = document.createElement("input");
        input.type = "password";
        input.placeholder = isSet ? "(leave blank to keep current value)" : "(enter to set)";
        input.value = "";
        const reveal = document.createElement("button");
        reveal.type = "button";
        reveal.className = "reveal";
        reveal.textContent = "👁";
        reveal.addEventListener("click", () => {
          input.type = input.type === "password" ? "text" : "password";
        });
        const wrap = document.createElement("div");
        wrap.className = "secret-wrap";
        wrap.appendChild(input);
        wrap.appendChild(reveal);
        row.appendChild(wrap);
        if (f.description) {
          const d = document.createElement("p"); d.className = "desc"; d.textContent = f.description;
          row.appendChild(d);
        }
        input.dataset.key = f.key;
        input.dataset.type = f.type;
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

  function validatePattern(input, pattern) {
    if (!pattern) return;
    const re = new RegExp(pattern);
    input.classList.toggle("invalid", input.value.length > 0 && !re.test(input.value));
  }

  function collect() {
    const out = {};
    for (const row of $("form").children) {
      const groupKey = row.querySelector(".checkbox-group");
      if (groupKey) {
        const k = row.querySelector("label").textContent.trim().split(/\s/)[0];
        const vals = [...groupKey.querySelectorAll("input:checked")].map(c => c.value);
        if (vals.length) out[k] = vals.join(",");
        continue;
      }
      const keyEl = row.querySelector("[data-key]");
      if (!keyEl) continue;
      const k = keyEl.dataset.key;
      const t = keyEl.dataset.type;
      if (t === "bool")        out[k] = keyEl.checked ? "1" : "0";
      else if (t === "secret") { if (keyEl.value) out[k] = keyEl.value; }
      else                     { if (keyEl.value !== "") out[k] = keyEl.value; }
    }
    return out;
  }

  function persistFormFromDom() {
    if (!schema) return;
    scopes[activeScope].form = collect();
    saveState();
  }

  function bindFormChanges() {
    $("form").addEventListener("input", persistFormFromDom);
  }

  function saveState() {
    vscode.setState({ schema, activeScope, scopes });
  }

  // ---- Save / Revert -------------------------------------------------------
  $("save").addEventListener("click", () => {
    persistFormFromDom();
    vscode.postMessage({ type: "save", scope: activeScope, values: collect() });
  });
  $("revert").addEventListener("click", () => {
    scopes[activeScope].form = { ...scopes[activeScope].initial };
    saveState();
    renderActive();
  });

  vscode.postMessage({ type: "ready" });
})();
