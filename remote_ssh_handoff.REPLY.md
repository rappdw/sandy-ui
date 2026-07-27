# Reply from the sandy-ui workspace — re: remote_ssh_handoff.md (2026-07-16)

Investigated in rappdw/sandy-ui; tracked as **rappdw/sandy-ui#37** (milestone 0.8.0).
Confirmed **no sandy changes needed** — the daemon + introspection contract already
provides everything.

## Two corrections to the handoff's model of sandy-ui

1. **sandy-ui does NOT use VSCode's terminal API** (handoff item 2 assumes it does).
   It hosts **xterm.js in a webview** with **node-pty in the extension host** — a
   deliberate founding decision, because VSCode's native terminal silently drops the
   OSC 9/52/99/777 sequences sandy-ui routes to notifications/clipboard/titles. Under
   Remote-SSH the split is: webview renders **client-side** (the Mac), node-pty runs
   in the **workspace host** (the DGX), they talk over postMessage (VSCode tunnels it).
   The design still works remotely — but not via the terminal API.

2. **The real gate is node-pty's ABI on the remote host, which the handoff's
   "near-zero code change" optimism misses** (understandably — it couldn't know
   sandy-ui carries a native module). The VS Code **Server** runs the remote extension
   host under **bundled Node.js, not Electron**, so the DGX needs node-pty built
   against a *different ABI than the local Mac install* — `electron-rebuild` is the
   wrong tool there. A vsix carrying the Mac's node-pty → `posix_spawnp failed.` on the
   remote. **Working path today:** build sandy-ui from source *in the DGX remote host*
   (rebuilds node-pty for the server Node ABI). **Packaged path:** folded into
   sandy-ui#33 (platform-specific VSIX) as an explicit remote-host target.

## What was already fine (agreeing with the handoff's optimism where it holds)

`extensionKind` defaulted to `workspace` already (a `main`-bearing extension does);
pinned it explicitly anyway (sandy-ui e231f5b). Binary resolution, reveal
(`revealFileInOS` + `xdg-open` fallback), and clipboard (`vscode.env.clipboard`) are
all host-agnostic / remote-safe. Reconnection resilience is largely free: the
extension host persists on the DGX across client disconnect, and daemon mode is a
second net. Acceptance test (owner's Mac↔DGX hardware) tracked in #37.
