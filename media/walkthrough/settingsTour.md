**Sandy: Open Settings** is a schema-driven form generated from `sandy --print-schema` — it always matches whatever sandy version you have installed, with live `pattern` / `min` / `max` validation as you type.

Two scope tabs, each showing its own file:

- **Project** (default) — `<workspace>/.sandy/config`
- **Global** — `~/.sandy/config`

Privileged keys (network/isolation toggles, credential variables) get a yellow border. Setting one from the **workspace** tab means sandy asks for your approval on the next launch: sandy-ui first shows a read-only preview of each key and its value exactly as written (credentials masked), and sandy asks in the terminal. Keys set in the **Global** tab need no approval, since you set them in your own directory.

**Save writes only what you changed.** Settings you don't touch stay as they are, so sandy's own defaults keep applying. Comments and the order of lines in the file are kept. Secrets (API keys, tokens) go to `.sandy/.secrets` next to the config file, and the panel shows only whether each is set, never its value.

[Open Settings](command:sandy.settings.open)
