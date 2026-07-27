# Runbook: sandy-ui against a remote sandy (DGX) over Remote-SSH

Manual acceptance test for [#37](https://github.com/rappdw/sandy-ui/issues/37) — running the
full sandy-ui UX against a sandy on an always-on remote host (a DGX Spark here), via VSCode
**Remote-SSH**. The extension is a **workspace extension** (`extensionKind: workspace`), so
its extension host runs on the remote and drives *that* machine's sandy/docker/tmux.

Cannot be automated (needs real Mac↔DGX hardware + Twingate transport). Run it by hand when
validating the remote workflow, or when [#33](https://github.com/rappdw/sandy-ui/issues/33)
(platform-specific VSIX with a remote server-Node target) needs an end-to-end check.

## Part 0 — Preconditions

On the **DGX**, in a plain SSH terminal:

```bash
sandy --version              # must be >= 1.1.0 (daemon mode)
node --version               # NOTE this major (e.g. v20.x) — matters in Part 2
docker ps                    # docker reachable
```

On the **Mac**: VSCode with the **Remote-SSH** extension, and `ssh dgx` already working
(Twingate up).

## Part 1 — Put a daemon session on the DGX (so there's something to attach to)

In the DGX SSH terminal:

```bash
cd ~/dev/<some-project>      # a real workspace under $HOME
sandy --start                # detached daemon session; returns when attachable
sandy --print-state light | jq '.running_containers'   # confirm daemon:true, attached_clients:0
```

Leave it running. Note the workspace path — you'll open **that exact folder** from the Mac.

## Part 2 — Get sandy-ui into the *remote* extension host

**On the Mac**, in VSCode:

1. `Cmd+Shift+P` -> **Remote-SSH: Connect to Host** -> pick the DGX. New window opens;
   bottom-left green badge reads **SSH: dgx**.
2. **File -> Open Folder** -> the workspace from Part 1 (e.g. `~/dev/<some-project>` on the DGX).

**In that window's integrated terminal** (now running *on the DGX*):

```bash
git clone https://github.com/rappdw/sandy-ui ~/dev/sandy-ui
cd ~/dev/sandy-ui
npm install          # builds node-pty against the DGX's system Node
npm run compile
npm run install-vsix # packages + installs into the SSH:dgx extension host
```

Then `Cmd+Shift+P` -> **Developer: Reload Window**.

> ### The node-pty ABI checkpoint (#37's whole reason for existing)
>
> If launching sandy fails with `posix_spawnp failed.`, the DGX's system Node ABI doesn't
> match the VS Code **Server**'s bundled Node (the remote extension host runs under the
> server's Node, **not** Electron). Rebuild node-pty against the server's node:
>
> ```bash
> SERVER_NODE=$(find ~/.vscode-server -name node -type f -path '*/server/node' 2>/dev/null | head -1)
> [ -z "$SERVER_NODE" ] && SERVER_NODE=$(find ~/.vscode-server/bin -maxdepth 2 -name node -type f 2>/dev/null | head -1)
> "$SERVER_NODE" --version    # note its major
> cd ~/dev/sandy-ui/node_modules/node-pty
> npx node-gyp rebuild --nodedir="$(dirname "$SERVER_NODE")/.."
> cd ~/dev/sandy-ui && npm run install-vsix
> ```
>
> Reload window, retry. This friction is exactly what #33 eliminates with a prebuilt
> remote target. **Whether the rebuild was needed is a headline result to report** (see
> Part 5) — it directly informs #33's target matrix.

## Part 3 — Acceptance checks (all against the DGX)

| # | Action (Mac VSCode, SSH:dgx window) | Expected | Cross-check (DGX terminal) |
|---|---|---|---|
| 3.1 | Open the **Sandy** activity-bar view | Tree lists the DGX daemon session (Part 1), badged **persisted** | `sandy --print-state light \| jq '.running_containers[].sandbox'` matches |
| 3.2 | Click that session (or status bar -> pick it) | A **Sandy** tab opens showing the **live agent tmux** — same screen the DGX CLI sees | `... jq '.running_containers[].attached_clients'` went `0 -> 1` |
| 3.3 | Also `sandy --attach` from a DGX terminal | Last-attach-wins: one client displaces the other (no split-screen fight) | displaced client detaches cleanly |
| 3.4 | Type in the agent tab | Keystrokes reach the DGX agent (it responds) | — |
| 3.5 | Open a workspace file in the editor, edit + save | The agent (same bind-mounted host files) sees the change | `cat <file>` on the DGX shows the edit |
| 3.6 | Status-bar **Stop** (or tree -> Stop sandy) | Session tears down | `... jq '.running_containers'` -> container gone; `docker ps` confirms |

## Part 4 — Reconnection test (the real payoff)

1. Re-`sandy --start` a session and attach it in the UI (repeat 3.1-3.2).
2. **Bounce the network**: Mac Wi-Fi off ~15s, back on (or move to a different network).
3. VSCode shows "Disconnected... Reconnecting...", then recovers the **SSH: dgx** window.
4. **Expected**: the Sandy tree and the attached agent tab **come back** — the extension
   host never died on the DGX (it persists across client disconnect) and the daemon
   container was never touched. The webview repaints; the agent screen is intact.

## Part 5 — What to report back

Per section:

- **Happy path or ABI-rebuild?** Did Part 2 need the node-pty rebuild? If so, what were
  `node --version` (DGX system) and the server node's version? -> direct input for #33.
- **Any of 3.1-3.6 that misbehaved**, plus the "Sandy" / "Sandy State" output-channel
  contents if so.
- **Part 4 recovery**: clean, or did anything need a manual reattach/reload?

Clean run -> close #37. Anything off -> precise follow-ups; the ABI answer feeds #33.

## Expectations

- **Most likely snag is Part 2's ABI rebuild.** If the DGX runs the same Node major as the
  VS Code Server bundles, plain `npm install` just works; otherwise the rebuild box is the
  path. Either outcome is a useful #37 result — "needed rebuild" is the finding that
  justifies #33's remote target.
- **Everything else should just work** — the #37 investigation confirmed binary resolution,
  reveal (`revealFileInOS` + `xdg-open` fallback), and clipboard (`vscode.env.clipboard`)
  are already host-agnostic. Interesting failures would be genuine surprises worth capturing.
