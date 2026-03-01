# PLAN_WEEK_4_CODEX

## Summary
Week 4 HLS productivity harness is implemented with:
- deterministic Bunny smoke playback test (Playwright + local harness page)
- strict unsigned token-enforcement guard
- redacted diagnostics for URLs and error payloads
- optional room E2E flow with stable `data-testid` selectors
- pnpm-based scripts and Playwright setup

## Implemented Files

### Tooling and config
- `package.json`
- `pnpm-lock.yaml`
- `playwright.config.ts`

### HLS scripts
- `scripts/hls/args.ts`
- `scripts/hls/env.ts`
- `scripts/hls/redact.ts`
- `scripts/hls/printSignedUrl.ts`
- `scripts/hls/assertTokenEnforcement.ts`
- `scripts/hls/runSmoke.ts`
- `scripts/hls/runRoomE2E.ts`

### Smoke + E2E tests
- `tests/hls/player.html`
- `tests/hls/server.ts`
- `tests/hls/hls-playback.spec.ts`
- `tests/hls/room-playback.spec.ts`

Room E2E now includes a dedicated regression case for:
- cookie bypass + reload + delayed gesture start
- post-start stability checks (`waiting`/`stalled` count and steady `currentTime` advance)

### UI test hooks
- `components/Access/InviteGateModal.tsx`
- `components/Video/HlsSyncPlayer.tsx`

### Docs
- `README.md`

## Locked Behavior

### Smoke harness
- smoke server binds `127.0.0.1`
- browser origin is always `http://localhost:${HLS_SMOKE_PORT}` (default `4173`)
- loud `EADDRINUSE` error: `Port <port> in use. Stop the other process or set HLS_SMOKE_PORT.`
- `manifestParsed` metric means `Hls.Events.MANIFEST_PARSED` fired
- pass gate A: `currentTime > 1` and `fragsLoaded >= 1`
- pass gate B: after 2s, `currentTime` increases by at least `0.2`
- ABR determinism: `startLevel: 0` and force level `0` only when levels exist

### Token propagation and redaction
- auth allowlist keys default to: `token`, `bcdn_token`, `expires`, `token_path`
- merges auth params without overwriting existing query params
- applies auth params only for URLs on the manifest protocol+host
- redaction applied to script logs, response/request diagnostics, and browser console payload parsing

### Token guard
- unsigned URL derivation removes only auth keys, preserves other query params
- traversal checks:
  - unsigned master playlist
  - unsigned media playlist
  - unsigned `EXT-X-MAP` URI if present, else first segment URI
  - unsigned `EXT-X-KEY` URI if present
- request method is `GET` only
- segment/key checks use `Range: bytes=0-1`
- decision rules:
  - fail on unsigned `2xx`
  - fail on unsigned `3xx`
  - pass only on `401/403/404/410`
  - fail on all other statuses

### Retry policy
- retry classes:
  - `timeout`
  - `network_error` (`net::ERR_*` or `NS_ERROR_*`)
  - `http_5xx`
- non-retryable:
  - all `http_4xx`
  - token guard failures
  - config/data validation failures
  - unknown classes
- one retry max and only in bunny mode

## Added Commands
- `pnpm playwright:install`
- `pnpm test:hls:print-url -- --room demo`
- `pnpm test:hls:guard -- --url "<signed-url>"`
- `pnpm test:hls:url -- --url "<manifest-url>"`
- `pnpm test:hls:bunny -- --room demo`
- `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --invite-code "..."`
- `pnpm test:hls:smoke`

## Verification Run
- `pnpm lint`: passed
- `pnpm build`: passed
- `pnpm test:hls:bunny -- --room demo`: passed (guard + smoke)
- `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo`: failed in current app state
  - observed in sync debug snapshot during failure:
    - `playbackStartState: PRIMING_REQUIRED`
    - `readyState: 0`
    - `readinessStage: INIT`
    - status text showed `Refreshing stream token... (sync idle)`
    - `currentTime` remained `0` (both baseline room test and delayed-gesture regression case)

## Notes
- room E2E expects invite code when invite modal is present (`HLS_E2E_INVITE_CODE` or `--invite-code`)
- raw HAR remains opt-in (`HLS_SMOKE_RAW_HAR=1`) because raw URLs may contain access tokens
