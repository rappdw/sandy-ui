# Execution prompt: drive sandy 1.0.1 → 1.1.0 (the daemon-mode release)

> **Purpose**: paste the body of this file as the prompt to a Claude (or other
> coding agent) running in a clone of `github.com/rappdw/sandy`. Unlike the
> single-task handoffs this repo used to hold, this is an *orchestration*
> prompt: it sequences existing GitHub issues across two milestones. The
> issues carry the specs; this prompt carries the order and the reasoning.

---

You're working in the sandy repo (v1.0.0 shipped 2026-07-10). The goal is to
reach **1.1.0 — the daemon-mode release** — via 1.0.1, in that order. The
sequencing rationale and per-issue specs live in the GitHub issues and
milestones; do not re-derive scope from scratch.

## Phase 1 — milestone 1.0.1 (bugfix batch)

Work the open issues in milestone `1.0.1`. **Do #14 first** (signal-trap
exit + atomic stale-lock takeover + PID-owned lock release): it restructures
the trap/lock-ownership code that Phase 2's daemon-mode builds on, and it
wants maximum soak time. The rest of the milestone (#12, #13, #15, #23, #24,
#25, #28, #30) is order-insensitive; batch related ones where natural
(#13+#15 are both cred/proxy-adjacent; #28 is the passive-key re-audit —
treat any finding there as in-scope for 1.0.1, it's a security follow-up).

Release 1.0.1 when the milestone hits zero. Patch release: no new flags, no
schema changes.

## Phase 2 — milestone 1.1.0 (daemon-mode)

Headline: **#17** (`--start` / `--attach` / `--stop`). Before implementing,
read BOTH:
- the issue body (full task spec, surfaced from sandy-ui dogfooding), and
- the **integration contract comment**
  (https://github.com/rappdw/sandy/issues/17#issuecomment-4965082949) — the
  behavioral requirements of the primary consumer (sandy-ui's
  detach-on-VSCode-quit / reattach-on-relaunch flow, tracked as
  rappdw/sandy-ui#12). CLI shape is yours to choose; those six behaviors are
  the acceptance surface. Pay particular attention to: repaint-on-attach,
  client-death-never-stops-session, distinct exit codes on --stop, the
  `--print-state` attachable/daemon flag, and an explicit concurrent-attach
  policy.

Also in 1.1.0: **#26** (network orphan reaping extras) — synergistic, since
daemonized sessions raise the orphaned-network stakes when clients vanish.
Implement it after #17's lifecycle shape is settled so the reaper knows what
a "live daemon session" looks like.

Introspection contract discipline: new CLI flags appear in `--print-schema`
`cli_flags`; the new print-state field(s) are additive (no schema_version
bump needed per SPEC_INTROSPECTION's additive rule). sandy-ui
feature-detects daemon support from these — they're load-bearing, not
decorative.

Release 1.1.0. Minor release: new flags, additive schema.

## What NOT to do

- Don't fold daemon-mode into 1.0.1 — it's a feature, and it depends on
  #14's restructure having landed and soaked.
- Don't start #16 (teleport, milestone 1.2.0) — it deliberately builds on
  daemon-mode's primitives and comes after.
- Don't change plain `sandy`'s attached-lifecycle semantics — daemon-mode is
  opt-in via the new flags; bare-CLI users see zero change.

## Coordination

When #17's CLI shape is final (flag names, exit codes, print-state fields),
comment them on rappdw/sandy-ui#12 so the extension work can start against
the real contract rather than the proposed one.
