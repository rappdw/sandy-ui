**Sandy: Open Settings** is a schema-driven form generated from `sandy --print-schema` — it always matches whatever sandy version you have installed, with live `pattern` / `min` / `max` validation as you type.

Two scope tabs, each showing its own file:

- **Project** (default) — `<workspace>/.sandy/config`
- **Global** — `~/.sandy/config`

Privileged keys (network/isolation toggles, credential variables) get a yellow border. Setting one from the **workspace** tab triggers a pre-flight approval modal on next launch — it renders the raw `KEY=VALUE` block verbatim, no HTML interpretation, so you see exactly what sandy will read. Home-set privileged keys skip the modal since you set them in your own directory.

**In this version the panel is read-only.** It shows every setting your sandy supports, but saving from it is turned off while a bug in how it writes settings is fixed. To change a setting, edit the file directly: the panel names it at the top.

[Open Settings](command:sandy.settings.open)
