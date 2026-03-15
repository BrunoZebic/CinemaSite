# Plan: GitHub Actions CI for Vercel-Backed Playback Verification

## Summary

This plan adds a practical GitHub Actions layer around the existing Vercel
deployment flow without duplicating deploy ownership. Vercel remains the only
deployment system. GitHub Actions is responsible for verification:

- fast PR quality gates (`lint`, `build`)
- Chromium room E2E against successful Vercel preview deployments
- nightly WebKit room E2E against production

Because room playback depends on time-based phase state, CI must reset one
dedicated screening to a known playable `LIVE` window before each room E2E run.

---

## Key Changes

### 1. GitHub workflow set

Add three workflows only:

1. `.github/workflows/pr-quality.yml`
   - triggers on `pull_request` to `main` and `workflow_dispatch`
   - runs `pnpm lint` and `pnpm build` as separate checks
   - uses pnpm + Node 20 with dependency caching

2. `.github/workflows/preview-room-e2e.yml`
   - triggers on `deployment_status` and `workflow_dispatch`
   - runs only when preview deployment status is `success`, an environment URL is
     present, and `startsWith(github.event.deployment.environment, 'Preview')`
   - manual reruns accept `base_url`, `git_ref`, and optional `room`
   - installs Chromium with Playwright system dependencies
   - resets the dedicated CI room before running Chromium room E2E
   - uploads `test-results/**` and `playwright-report/**` on failure/cancel
   - artifact retention: 14 days

3. `.github/workflows/nightly-room-e2e.yml`
   - triggers nightly on a fixed cron and via `workflow_dispatch`
   - targets production URL from repo variables by default
   - installs WebKit with Playwright system dependencies
   - resets the dedicated CI room before running WebKit room E2E
   - uploads the same artifacts on failure/cancel for 14 days
   - visible failure only; not a required branch-protection check in v1

### 2. Room E2E runner changes

Update `scripts/hls/runRoomE2E.ts`:

- add `--project`
- default to `room-e2e-chromium`
- only set `PW_ROOM_WEBSERVER=1` when the target URL host is `localhost` or
  `127.0.0.1`
- never attempt to boot a local dev server for Vercel preview or production URLs

### 3. Playwright project split

Update `playwright.config.ts`:

- rename the current room project to `room-e2e-chromium`
- add `room-e2e-webkit`
- keep `hls-smoke` unchanged
- retain trace/video/screenshots on failure
- emit HTML report output into `playwright-report`

### 4. Deterministic CI room reset

Add `scripts/hls/resetCiRoom.ts`:

- use existing `@supabase/supabase-js`
- read Supabase URL from `CI_SUPABASE_URL` with fallback to
  `NEXT_PUBLIC_SUPABASE_URL`
- read service role key from `CI_SUPABASE_SERVICE_ROLE_KEY` with fallback to
  `SUPABASE_SERVICE_ROLE_KEY`
- require `--room`
- accept optional `--start-offset-sec`, default `-90`
- update only `premiere_start_unix_ms`
- exit non-zero on missing room, auth error, query failure, update failure, or
  any network error

### 5. CI-specific room playability enforcement

Update `tests/hls/room-playback.spec.ts`:

- add `HLS_E2E_FAIL_ON_NON_PLAYABLE_ROOM=1`
- when enabled, non-playable room state must fail instead of `test.skip`
- leave subtitle-room E2E out of CI for this step
  - do not set `HLS_TEST_SUBTITLE_ROOM`
  - do not set `HLS_TEST_SUBTITLE_INVITE_CODE`
  - subtitle tests remain intentionally outside CI scope in v1

### 6. Documentation

Update `README.md`:

- document the three workflows
- document required GitHub repo variables and secrets
- document the dedicated CI room requirement
- document manual dispatch inputs
- state explicitly that Vercel remains deployment owner

---

## CI Interfaces and Secrets

### Repo variables

- `CI_HLS_ROOM`
- `CI_HLS_PROD_BASE_URL`
- `CI_SUPABASE_URL`

### Repo secrets

- `CI_HLS_INVITE_CODE`
- `CI_HLS_HOST_SECRET`
- `CI_SUPABASE_SERVICE_ROLE_KEY`

### Workflow env passed to tests/scripts

- `HLS_TEST_ROOM`
- `HLS_TEST_INVITE_CODE`
- `HLS_TEST_HOST_SECRET`
- `HLS_TEST_BASE_URL`
- `HLS_E2E_FAIL_ON_NON_PLAYABLE_ROOM=1`
- `CI_SUPABASE_URL`
- `CI_SUPABASE_SERVICE_ROLE_KEY`

---

## Test Plan

Required validation for this work:

1. `pnpm lint`
2. `pnpm build`
3. `pnpm test:hls:unit`
4. `playwright ... --project=room-e2e-chromium --list`
5. `playwright ... --project=room-e2e-webkit --list`
6. import/compile sanity checks for `scripts/hls/runRoomE2E.ts` and
   `scripts/hls/resetCiRoom.ts`

Optional local room E2E sanity check:

- `pnpm test:hls:room -- --base-url http://localhost:3100 --project room-e2e-chromium`
- acceptable outcome in local dev: skipped due to non-playable room when the
  CI-only fail flag is not set

Live GitHub verification after merge/PR wiring:

- successful preview deploy triggers Chromium room E2E
- nightly run triggers WebKit room E2E
- artifacts are uploaded when either fails

---

## Assumptions and Defaults

- Vercel previews are reachable from GitHub-hosted runners without extra preview
  bypass credentials.
- One dedicated CI room is acceptable for v1.
- Preview and nightly workflows intentionally serialize on the same room via a
  shared concurrency key.
- Queueing between preview and nightly runs is an accepted v1 tradeoff; the
  next scaling step would be a second CI room, not weaker concurrency.
- `pnpm test:hls:bunny -- --room demo` is intentionally out of scope for this
  CI step.
