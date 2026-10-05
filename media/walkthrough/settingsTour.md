**Sandy: Open Settings** is a schema-driven form generated from `sandy --print-schema` — it always matches whatever sandy version you have installed, with live `pattern` / `min` / `max` validation as you type.

Two scope tabs, each showing its own file:

- **Project** (default) — `<workspace>/.sandy/config`
- **Global** — `~/.sandy/config`

Privileged keys (network/isolation toggles, credential variables) get a yellow border. Setting one from the **workspace** tab triggers a pre-flight approval modal on next launch — it renders the raw `KEY=VALUE` block verbatim, no HTML interpretation, so you see exactly what sandy will read. Home-set privileged keys skip the modal since you set them in your own directory.

**Save writes only what you changed.** Settings you don't touch stay as they are, so sandy's own defaults keep applying. Comments and the order of lines in the file are kept. Secrets (API keys, tokens) go to `.sandy/.secrets` next to the config file, and the panel shows only whether each is set, never its value.

[Open Settings](command:sandy.settings.open)
