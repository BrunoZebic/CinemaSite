# Live Cinema Premiere Platform (Screening #1 Readiness)

This build implements:
- invite-code room access
- host passphrase controls
- HLS playback with native Safari support + `hls.js` fallback
- Bunny CDN advanced token signing (server-side only)
- custom video controls, iOS priming flow, and reconnect-safe resync
- 5-phase room flow (`WAITING`, `LIVE`, `SILENCE`, `DISCUSSION`, `CLOSED`)
- persisted chat archive (`room_messages`)
- persisted host moderation actions (`host_actions`)
- realtime reconnect watchdog + post-reconnect bootstrap re-fetch/resync

## Setup

0. Use Node.js `>=20.9.0`.

1. Install dependencies:
```bash
pnpm install
```

2. Configure environment:
```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ROOM_COOKIE_SECRET=...
NEXT_PUBLIC_SYNC_DEBUG=false
REHEARSAL_SCRUB_ENABLED=false
BUNNY_CDN_BASE_URL=...
BUNNY_TOKEN_AUTH_KEY=...
BUNNY_TOKEN_AUTH_MODE=advanced
BUNNY_TOKEN_EXPIRY_SEC=...
```

3. Apply database schema in Supabase SQL editor:
```sql
-- run file:
-- supabase/schema.sql
```

4. Seed a screening row in `screenings` with:
- `room_slug`
- `premiere_start_unix_ms` (UTC ms)
- `film_duration_sec`
- `silence_duration_sec` (default 20)
- `discussion_duration_min`
- `video_provider` = `hls`
- `video_manifest_path` = canonical relative path (example: `/screenings/film-slug/master.m3u8`)
- `video_asset_id` is optional legacy for Vimeo rooms only
- `invite_code_hash` = SHA-256 hex of invite code
- `host_passphrase_hash` = SHA-256 hex of host passphrase

Manifest hardening notes:
- store path only (not full URL) in `video_manifest_path`
- no protocol/hostname/query/`..` allowed
- signed manifest URL is minted in bootstrap only after invite-cookie validation
- unsigned manifest URLs are never returned in production bootstrap responses

## Bunny HLS Checklist

- MIME types:
  - `.m3u8` -> `application/vnd.apple.mpegurl`
  - `.ts` -> `video/mp2t`
  - `.m4s` -> `video/iso.segment`
- byte-range requests enabled
- CORS allows your Vercel origin(s)
- CDN caching enabled for segments and playlists

5. Start development server:
```bash
pnpm dev
```

6. Open:
```text
http://localhost:3000/premiere/demo
```

## API Endpoints
- `GET /api/time`
- `GET /api/rooms/[room]/bootstrap`
- `POST /api/rooms/[room]/access`
- `POST /api/rooms/[room]/host-auth`
- `GET /api/rooms/[room]/messages`
- `POST /api/rooms/[room]/messages`
- `POST /api/rooms/[room]/host-actions`

## Scripts
- `pnpm dev`
- `pnpm lint`
- `pnpm build`
- `pnpm test:hls:unit`
- `pnpm start`
- `pnpm test:hls:url -- --url "<manifest-url>"`
- `pnpm test:hls:bunny -- --room demo`
- `pnpm test:hls:guard -- --url "<signed-manifest-url>"`
- `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --invite-code "<code>"`
- `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
- `pnpm test:hls:room -- --base-url https://preview.example.vercel.app --room ci-room --invite-code "<code>" --project room-e2e-chromium`

## Week 4 HLS Self-Test Harness

Install Playwright Chromium once:
```bash
pnpm playwright:install
```

Smoke modes:
```bash
# direct URL smoke
pnpm test:hls:url -- --url "https://.../master.m3u8"

# Bunny room smoke (auto signs URL from DB + strict token guard)
pnpm test:hls:bunny -- --room demo
```

PowerShell note: quote full URLs in single quotes to keep `&` query params intact.

Optional full room E2E:
```bash
pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --invite-code "..."
```

Remote room E2E note:
- `scripts/hls/runRoomE2E.ts` only starts a local `pnpm dev` server for `localhost` / `127.0.0.1` base URLs.
- Vercel preview and production URLs run directly against the deployed app.

Behavior highlights:
- smoke server binds to `127.0.0.1` and browser origin is always `http://localhost:4173` (or `HLS_SMOKE_PORT`)
- room E2E canonical origin is `http://localhost:3100` (or `HLS_TEST_BASE_URL`)
- strict token guard fails if unsigned URLs are public (`2xx`) or redirect (`3xx`)
- retry is one time only and only for timeout/network/5xx classes in Bunny smoke mode
- all test diagnostics redact auth query params (`token`, `bcdn_token`, `expires`, `token_path`)
- full suite requires Bunny CORS to allow both `http://localhost:4173` and `http://localhost:3100`
- if room Chromium E2E fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` and video source points to `.m3u8`, treat it as engine-selection/native-path regression before CORS triage

Recommended Bunny CORS dev snippet:
- allow origins: `http://localhost:4173`, `http://localhost:3100`
- allow methods: `GET, HEAD, OPTIONS`
- allow request headers: `Range`

## GitHub Actions CI

This repo uses GitHub Actions for verification only. Vercel remains the only
deployment system.

Workflows:
- `PR Quality`: runs `pnpm lint` and `pnpm build` on PRs to `main`
- `Preview Room E2E`: runs Chromium room playback plus phase-transition UI E2E after a successful Vercel preview deployment
- `Nightly Room E2E`: runs WebKit room playback plus phase-transition UI E2E on a nightly schedule against production

Required GitHub repository variables:
- `CI_HLS_ROOM`
- `CI_HLS_PROD_BASE_URL`
- `CI_SUPABASE_URL`

Required GitHub repository secrets:
- `CI_HLS_INVITE_CODE`
- `CI_HLS_HOST_SECRET` (reserved for future host/auth flows; safe to set now)
- `CI_SUPABASE_SERVICE_ROLE_KEY`

Dedicated CI room requirements:
- create one active screening row reserved for CI
- point `CI_HLS_ROOM` at that room slug
- ensure the room uses a valid HLS manifest and invite code
- the CI workflows reset `premiere_start_unix_ms` before each job to force the room into `LIVE` for playback verification; the phase suite then applies its own deterministic offsets internally

Manual dispatch inputs:
- Preview Room E2E requires `base_url` and `git_ref`, with optional `room`
- Nightly Room E2E accepts optional `base_url`, `git_ref`, and `room`

Artifact policy:
- failing or cancelled room E2E workflows upload `test-results/**` and `playwright-report/**`
- artifacts are retained for 14 days

## Rehearsal Debug Overlay

Enable sync debug overlay:
```bash
NEXT_PUBLIC_SYNC_DEBUG=true
```

Overlay fields:
- `phase`
- `playerTime`
- `targetTime`
- `drift`
- `channelStatus`
- `isDriftLoopActive`
- `serverOffsetMs`
- `readyState`
- `buffering`
- `lastResyncAt`

Disable for public event builds.
