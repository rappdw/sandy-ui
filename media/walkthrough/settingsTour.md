**Sandy: Open Settings** is a schema-driven form generated from `sandy --print-schema` — it always matches whatever sandy version you have installed, with live `pattern` / `min` / `max` validation as you type.

Two scope tabs, each editing its own file:

- **Project** (default) — `<workspace>/.sandy/config`
- **Global** — `~/.sandy/config`

Privileged keys (network/isolation toggles, credential variables) get a yellow border. Setting one from the **workspace** tab triggers a pre-flight approval modal on next launch — it renders the raw `KEY=VALUE` block verbatim, no HTML interpretation, so you see exactly what sandy will read. Home-set privileged keys skip the modal since you set them in your own directory.

[Open Settings](command:sandy.settings.open)
