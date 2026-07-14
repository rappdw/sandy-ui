# Orchestration prompt: sandy 1.1.0 — the daemon-mode release (plan → implement → verify loop)

> **Purpose**: paste the body below (everything after the `---`) as the prompt
> to a Claude session in a clone of `github.com/rappdw/sandy`. Start that
> session on **Opus 4.8** (`claude --model claude-opus-4-8`, or `/model` after
> launch) — the orchestrator/planner rides on the main-loop model; the prompt
> pins subagent models per phase via the Task tool (`sonnet` → Sonnet 5 for
> implementation, `opus` → Opus 4.8 for fresh-context verification).
>
> Precondition (met 2026-07-14): v1.0.1 is released with #14's lifecycle
> hardening landed — daemon-mode builds on that trap/lock-ownership base.

---

You are the ORCHESTRATOR for milestone 1.1.0 in this repo (rappdw/sandy —
v1.0.1 shipped; this is THE DAEMON-MODE RELEASE, the first feature release
after 1.0). You are running as Opus 4.8 and you do the PLANNING and final
judgment yourself; you delegate IMPLEMENTATION to Sonnet subagents and
VERIFICATION to fresh Opus subagents. Follow this repo's CLAUDE.md
conventions throughout.

REQUIRED READING before Batch 1 planning — all four, they are the spec:
- `gh issue view 17` — the full task spec (CLI shape, container-labels
  state, test matrix, back-compat options, out-of-scope list)
- Its TWO contract comments from the primary consumer (sandy-ui):
  the six-behavior integration contract, and the post-1.0.1 addendum
  (attach exit codes, --start output surface, helper reparenting,
  attached_clients, bare-sandy-vs-daemon decision, #14 lock interplay)
- `gh issue view 26` — network orphan extras (rides in this release)
- rappdw/sandy-ui#12 — how the consumer will drive these flags; useful for
  judging ambiguities the way the consumer would

BATCHES (strictly in order — each builds on the prior's landed shape):

  Batch 1: `--start` — the daemonized launch path.
    Same launch pipeline as interactive sandy up to (not including) the
    attach phase; session registered via container labels; host-side helper
    processes (SSH-agent relay socat, channel relay, proxy-sidecar mgmt)
    reparented into the session's daemon tree so they survive the starter
    exiting and die on --stop. Startup contract: progress streams to
    stdout/stderr while it runs; exit 0 only once attachable; non-zero with
    a useful final line on failure; idempotent when a session already runs.
    Lock is acquired and OWNED by the daemonized process (per #14's
    PID-owned model).

  Batch 2: `--attach` + `--stop` + bare-`sandy` semantics.
    --attach: interactive client onto the running session's inner tmux via
    docker exec; full repaint on attach (SIGWINCH/resize-toggle); client
    death or clean detach NEVER stops the session. Distinct, documented
    exit codes: session-ended-while-attached vs detached-session-lives; an
    attached client sees the session-ended code when --stop runs elsewhere.
    Concurrent attach: pick and document a policy (refuse, or last-wins
    detaching the prior client) — silent mirroring is the only wrong answer.
    --stop: signals the daemon so ITS trap runs the full cleanup (docker
    stop, network rm, lock release) — never removes another PID's lock
    (that's exactly what #14 guards). Distinct exit codes for no-such-
    session vs stop-failed. Decide + document what bare `sandy` does when a
    daemon session exists for the workspace (error-with-hint or
    auto-attach); bare sandy's default lifecycle for ITS OWN sessions is
    unchanged (close terminal = teardown, zero change for existing users).

  Batch 3: introspection surface.
    New flags appear in --print-schema cli_flags (the consumer
    feature-detects on presence, not version strings). --print-state grows
    additive fields: per-session daemon/attachable flag + attached_clients
    (tmux #{session_attached} via docker exec is the cheap truth source).
    While in there: the running_containers[].sandbox ↔ sandboxes[].name
    consistency audit called out in #17's spec. Additive-only per
    SPEC_INTROSPECTION — no schema_version bump.

  Batch 4: #26 — network orphan extras (prune-on-startup policy,
    --prune-orphans, orphan_networks count). Done last so the reaper is
    written against the settled definition of "live daemon session".

FOR EACH BATCH, RUN THIS LOOP:

1. PLAN (you, Opus 4.8, in the main session):
   Read the relevant spec sections AND the actual code paths. Write
   plans/batch-N.md (not committed): exact functions/regions to change,
   approach per sub-item, edge cases that must keep working (especially:
   bare-sandy interactive flow untouched; #14's lock guards), tests to run
   (repo suite + the #17 test matrix rows this batch covers + relevant
   TESTING_PLAN.md sections), acceptance checks derived from the issue and
   BOTH contract comments. Record `git rev-parse HEAD` as the baseline.

2. IMPLEMENT (Task subagent, model: sonnet — Sonnet 5):
   Hand it the plan file path, issue numbers, baseline SHA. Instructions:
   implement EXACTLY the plan; run the suite; commit per coherent unit with
   issue references ("Refs #17" per batch, "Fixes #17"/"Fixes #26" only on
   the batch that completes the issue); if the plan is wrong or ambiguous,
   STOP and report — plan changes are the orchestrator's call. It reports:
   per-file changes, test results, deviations requested.

3. VERIFY (Task subagent, model: opus — Opus 4.8, FRESH context):
   Give it ONLY the issue numbers, the plan file, the baseline SHA, and:
   "Adversarially review `git diff <baseline>..HEAD` against the plan, the
   issue, and the two contract comments on #17. Do not trust the
   implementer's report — re-run tests yourself, and for THIS feature
   actually exercise the lifecycle where the environment allows: --start
   then kill -9 the attach client → container must survive; re-attach →
   repaint + working keys; --stop with a client attached → client exits
   with the session-ended code, lock released by the daemon, no orphaned
   networks/locks; --start twice → idempotent; bare sandy → byte-for-byte
   today's behavior. Check minor-release discipline: introspection changes
   additive-only, no existing key/flag removed or repurposed. Verdict:
   PASS, or FAIL with specific findings (file:line, failure scenario)."

4. On FAIL: triage, amend the plan, new implement round (sonnet; take
   subtle/judgment fixes yourself), re-verify with a FRESH Opus subagent.
   Loop until PASS. Only then the next batch.

GLOBAL RULES:
- Do NOT change bare `sandy`'s default semantics for its own sessions.
- Do NOT start #16 (teleport, 1.2.0) — it consumes these primitives later.
- Out-of-scope list in #17 stands: no socket server, no layout redesign,
  no multi-session-per-workspace.
- Ambiguity between the issue body and the contract comments: the contract
  comments win (they're newer and consumer-derived); note the divergence on
  the issue as you resolve it.

END-TO-END ACCEPTANCE (after Batch 3, before Batch 4):
Run the actual target scenario yourself: `sandy --start` in a scratch repo →
attach → exchange a message with the agent → kill the attach client
abruptly → verify container + agent still running and helper processes
alive → `sandy --attach` again → prior conversation/screen intact → `sandy
--stop` → container, network, lock all gone. This is the scenario the
consumer (sandy-ui#12) exists for; if it doesn't hold, the release isn't
ready regardless of green unit tests.

WHEN DONE:
Prepare the release but DO NOT tag or publish: version bump to 1.1.0 per
repo convention, curated RELEASE_NOTES.md section (lead with daemon-mode;
document the new exit codes and the concurrent-attach + bare-sandy
decisions prominently — consumers build against them). Then: comment the
FINAL CLI shape (flags, exit codes, print-state fields) on
rappdw/sandy-ui#12 so the extension's 0.6.0 work starts against the real
contract. Final report: per-batch plan → outcome → verify verdict
(including FAIL rounds and what they caught), end-to-end acceptance
evidence, deferred items. The owner reviews, then cuts the release.
