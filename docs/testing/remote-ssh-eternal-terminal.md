# Runbook: resilient Remote-SSH via Eternal Terminal (mosh-style roaming for the IDE)

An **experiment**, not a supported path (yet). Goal: make a VSCode **Remote-SSH** session to
an always-on server (a DGX here, reached over Twingate) survive network changes / laptop
sleep the way `mosh` makes a *terminal* survive them — so the full sandy-ui remote UX (from
[`remote-ssh-runbook.md`](remote-ssh-runbook.md)) stops dropping on flaky networks.

**Why not mosh?** mosh synchronizes *terminal screen state* over UDP and has no port
forwarding — it can't carry VSCode's server RPC stream. **Eternal Terminal (`et`)** is the
mosh-shaped tool that *does* provide a resilient, reliable, port-forwarding connection, so
it can. Background: [sandy-ui#37](https://github.com/rappdw/sandy-ui/issues/37) discussion.

## The architecture (read this first — every step follows from it)

```
Mac                                             DGX
┌──────────────────────────────┐               ┌────────────────────────────┐
│ VSCode Remote-SSH             │               │  sshd (22)                 │
│   └─ ssh -> localhost:8022 ───┼──ET tunnel────┼─> forwarded to :22 -> VS   │
│ et client (roaming anchor) ═══╪══ resilient ══╪═> Code Server + sandy-ui   │
│   -t 8022:22                  │   link (2022) │   etserver (2022)          │
└──────────────────────────────┘               └────────────────────────────┘
```

`et` holds a **resilient link** to the DGX and **port-forwards** the DGX's ssh port (22) to
`localhost:8022` on the Mac. VSCode SSHes to `localhost:8022`, so its server connection
rides *inside* the ET tunnel. When the network blips, `et` heals the underlying link and the
forwarded stream resumes; VSCode sees a stable localhost socket. ET absorbs the turbulence
that would otherwise drop raw Remote-SSH. sandy-ui is untouched — this is pure transport,
below the extension.

## Part 0 — Prove ET survives a bounce at all (5 min, NO VSCode)

If ET can't roam through Twingate on its own, VSCode-over-ET won't either. Fail fast here.

1. **Install both ends:**
   - Mac: `brew install eternal-terminal`
   - DGX (Ubuntu/Debian ARM64): `sudo add-apt-repository ppa:jgmath2000/et && sudo apt update && sudo apt install et` (build from source if the PPA lacks arm64).
2. **Server on the DGX:** `sudo systemctl enable --now et` (installs `etserver`, default **TCP 2022**). Verify: `systemctl status et`.
3. **Firewall / Twingate:** allow **TCP 2022** to the DGX (in addition to 22 — `et` bootstraps over ssh, then runs on 2022).
4. **Connect + bounce:** on the Mac, `et dgx` → you land in a DGX shell. Turn Wi-Fi off ~20s, back on. The session should **freeze then resume**, not die.
   - Survives → continue.
   - Dies → stop; ET isn't roaming through your network (likely 2022 not open, or Twingate resetting the flow). Fix that before touching VSCode.

## Part 1 — Establish the resilient SSH tunnel

On the Mac, in its own terminal — **leave it running; it's the roaming anchor.** Running it
inside a local `tmux`/`screen` makes it easy to keep alive across Mac terminal restarts:

```bash
et dgx -t "8022:22"      # resilient link + forward local 8022 -> DGX:22
```

> Confirm the flag with `et --help`. The tunnel flag is `-t` / `--tunnel`; format is usually
> `localPort:remotePort`, but some builds want `localPort:remoteHost:remotePort`
> (i.e. `8022:localhost:22`). **Record which your build accepted** — it goes in the report.

You get a DGX shell *and* the forward runs in the background. Sanity-check from a second Mac
terminal:

```bash
ssh -p 8022 rappdw@localhost      # should land on the DGX
```

## Part 2 — Point VSCode Remote-SSH at the tunnel

Add to `~/.ssh/config` on the Mac:

```sshconfig
Host dgx-et
  HostName localhost
  Port 8022
  User rappdw
  StrictHostKeyChecking accept-new     # localhost:8022 presents the DGX host key (new known_hosts entry)
  IdentityFile ~/.ssh/<your-dgx-key>
```

Then: `Cmd+Shift+P` → **Remote-SSH: Connect to Host** → **dgx-et** → **Open Folder** → your
DGX workspace. VSCode SSHes to `localhost:8022` → ET tunnel → DGX sshd → VS Code Server, as
normal.

## Part 3 — Run the sandy-ui remote flow

Everything in [`remote-ssh-runbook.md`](remote-ssh-runbook.md) applies **unchanged** — install
sandy-ui in the remote host (Parts 2-3 there), attach to a DGX daemon session, etc. ET is
invisible to the extension. Get to a working attached agent tab.

## Part 4 — The payoff test (the whole point)

With sandy-ui attached to a DGX session over the `dgx-et` connection:

1. **Bounce the network** (Wi-Fi off ~20-30s, back on; or physically switch networks).
2. Watch VSCode's connection indicator and the Sandy tab.
3. **Compare against the baseline** you already know from raw Remote-SSH: plain `ssh` gives
   "Disconnected… reconnecting…" and a full re-handshake. With ET underneath, the expectation
   is the tunnel heals transparently and VSCode recovers faster — ideally without a visible
   full reconnect cycle, and the attached agent tab comes right back.

## Honest expectations — this is a measurement, not a guarantee

- **Bounce-survival is exactly what you're measuring.** ET resumes its link fast and replays
  the forwarded stream, but whether VSCode's server connection survives depends on ET
  resuming *before* VSCode's own connection timeout fires. Likely **better** than raw SSH;
  "seamless" is the hypothesis, not a promise. Note what actually happened.
- **The `et` client is the anchor** — if it dies, the tunnel dies. tmux/screen it.
- **Bootstrap still needs ssh (22)** working to the DGX; ET spawns its remote side over ssh.
- **Host-key churn:** `[localhost]:8022` gets its own known_hosts entry; `accept-new` covers
  the first connect.
- **Zero sandy-ui changes** — transport only.

## What to report back

- **Part 0:** did plain `et dgx` survive a bounce? (gate — if no, stop.)
- **Exact `et` tunnel flag** your build accepted (`8022:22` vs `8022:localhost:22`).
- **Part 4:** on a network bounce with VSCode-over-ET, what happened vs raw Remote-SSH —
  full reconnect / faster reconnect / seamless? Did the attached sandy agent tab recover?
- Any snags (Twingate + 2022, host-key, et-client dying, VSCode timeout).

If it works well, this graduates from experiment to a documented option (and a short note in
the README's Remote-SSH section). If it doesn't, the report says why — and the fallback
remains: raw Remote-SSH (server persists across drops; reconnect is just SSH-flaky) for the
IDE, or `mosh`+`tmux`+sandy-daemon for a resilient *terminal-only* agent session.
