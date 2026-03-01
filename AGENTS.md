# AGENTS.md — Codex Development Contract

This file defines non-negotiable rules for agents (Codex) working on this repo.

If an instruction conflicts with a user-approved plan doc (PLAN_WEEK_*), follow the plan doc. If multiple plans conflict, follow the newest revision.

## 0) Product Doctrine (Do Not Drift)

We are building a **scheduled, synchronized online screening ritual**:
- Join a room before a fixed start time.
- Film plays **in sync** (late joiners catch up; no rewind during LIVE).
- **SILENCE** phase: black screen, chat locked.
- **DISCUSSION** phase: calm, minimalist.
- Room closes; archive preserved internally.

We are **not** building:
- a streaming library, social network, profiles, a social graph, gamification, heavy UI polish over function.

If you are about to introduce features that look like a library, feed, reactions, discovery, or “social app,” stop and ask for confirmation.

## 1) How Work Is Requested and Approved

### 1.1 Plan-first workflow
Most work follows:
1) Draft Plan
2) Human review
3) Revise Plan until no major notes
4) Implement exactly the plan

When a PLAN_WEEK_* exists, implementation must:
- Match locked decisions
- Respect scope/non-goals
- Preserve invariants and precedence rules
- Keep acceptance criteria intact

### 1.2 Change boundaries
Do not “improve” unrelated code while implementing a plan.
Small refactors are allowed only if they:
- reduce risk for the current change
- are localized
- do not change runtime behavior
- are justified in the final summary

If you want to do a refactor, propose it first.

## 2) Repo Hygiene Rules

### 2.1 Keep secrets safe
Never print or commit:
- Bunny tokens / signed URL query params
- Supabase service role keys
- any auth cookies or cookie secrets

When logging URLs in tests/tools, always use the shared redaction utility.

### 2.2 No silent behavior changes
Any behavior change that affects:
- playback gating
- sync semantics
- phase transitions
- invite/host access
must have:
- a test case (unit/E2E/harness) or
- an explicit rationale in the PR summary

### 2.3 Determinism and cleanup
For state machines, playback adapters, and realtime subscriptions:
- prevent overlapping async writes (attempt tokens)
- clean up event listeners on unmount or restart
- avoid “thrash” loops (flickering buffering, repeated seeks)

## 3) Required Tests and When to Run Them

### 3.1 Always run for any PR
- `pnpm lint`
- `pnpm build`

### 3.2 Playback-related changes (required gate)
If you touched ANY of:
- HLS playback code paths (HlsSyncPlayer, hls adapter)
- Bunny signing or manifest URL handling
- token propagation logic
- access gating that affects playback start
- autoplay/gesture priming logic
you MUST run:
- `pnpm test:hls:bunny -- --room demo`

If you touched invite/gesture UI or room flow, ALSO run:
- `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --invite-code "<code>"`

### 3.3 Debugging / targeted runs
- Validate a specific manifest:
  - `pnpm test:hls:url -- --url "<manifest-url>"`
- Security-only token enforcement checks:
  - `pnpm test:hls:guard -- --url "<signed-manifest-url>"`

### 3.4 Do not “declare done” without test output
When finishing a task that requires tests, include in the final message:
- which commands you ran
- whether they passed
- if something failed, the redacted error summary and next steps

## 4) HLS Harness Rules (Week 4)

The HLS harness is the source of truth for “does Bunny playback work.”

### 4.1 Smoke harness invariants (do not change lightly)
The smoke harness has locked behavior (port/origin, pass gates, ABR determinism, redaction, strict token guard, retry classification). Do not modify these without updating the plan doc and obtaining human approval.

### 4.2 Diagnostics must be token-safe
All harness logs and artifacts must:
- redact auth query keys
- avoid printing raw signed URLs
- avoid dumping headers/cookies that contain secrets

### 4.3 What “pass” means
A smoke pass means:
- manifest parsed event fired
- playback advanced beyond 1 second
- at least one fragment loaded
- post-start stall check passed

A token guard pass means:
- unsigned master/media/map/segment/key are not publicly accessible (non-2xx, non-3xx)
- only deny-style statuses are accepted by default (401/403/404/410)

## 5) Playback + Phase Semantics (High-Stakes)

### 5.1 Phases are authoritative
Server authority governs:
- access
- phase
- canonical time
- writes (messages, host actions)

Client is a controlled participant. Do not introduce client-authoritative state that overrides server phase/canonical time.

### 5.2 SILENCE is absolute
SILENCE always has precedence:
- black screen
- player paused
- drift correction off
- chat locked (recommended)

Nothing should “peek through” SILENCE (no CTA, no lobby overlays).

### 5.3 Gesture/priming rules
Follow the current locked UI/precedence rules:
- Gesture CTA appears only when needed and only when the player is shown
- WAITING lobby after priming is calm and non-interactive
- Normalization must not run in degraded recovery mode
- Muted-on-gesture-start remains enabled

If you encounter “audio choppy + buffering flicker after reload then enable playback,” treat it as a lifecycle/race bug and:
- add a room E2E regression case (invite cookie bypass + delayed enable)
- fix by eliminating double-attach / overlapping start attempts

## 6) UI Test Hooks (E2E Stability)

When implementing new flows that must be tested in Playwright:
- add `data-testid` selectors
- do not rely on visible text (CTAs may be textless)
- keep selectors stable over styling changes

Do not remove test IDs without updating tests.

## 7) How to Communicate Changes (Final Report Template)

When you finish a task, include:

### 7.1 Summary
- What changed (1–5 bullets)
- Which files were touched

### 7.2 Behavior Impact
- What user-visible behavior changed
- What should be manually sanity-checked (if any)

### 7.3 Tests Run
- Commands run + pass/fail
- If tests were skipped, explain why and propose next action

### 7.4 Risk Notes
- Any known edge cases
- Any follow-up tasks suggested (clearly labeled as optional)

## 8) “Stop and Ask” Triggers

Stop implementation and ask for confirmation if:
- You need to change server API contracts or DB schema
- You need to relax token enforcement or expose unsigned URLs
- You want to add “library/social” features
- You want to introduce a new dependency that affects runtime playback
- You want to rewrite the phase machine or drift correction semantics

## 9) Local Test Credentials (Development Only)

For deterministic local testing and Playwright E2E flows, the following
environment variables are used:

- `HLS_TEST_INVITE_CODE`
- `HLS_TEST_HOST_SECRET`

Default local values (DO NOT commit real secrets):
- `HLS_TEST_INVITE_CODE=myInviteCode`
- `HLS_TEST_HOST_SECRET=myHostSecret`

Rules:
1. These values must be supplied via environment variables.
2. They must NOT be hardcoded in source files.
3. They must NOT be logged or printed.
4. They must NOT be embedded in client-visible bundles.
5. Playwright room E2E should read from env, not literals.

If missing, tests should fail with a clear message:
"Missing HLS_TEST_INVITE_CODE or HLS_TEST_HOST_SECRET."

All test credentials must be stored in `.env.local` and listed in `.env.example`
without real values.

---

By working in this repo, you agree to follow this contract.