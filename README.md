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
- `pnpm test:hls:room:webkit -- --base-url http://localhost:3101 --room demo --invite-code "<code>"`

## Week 4 HLS Self-Test Harness

Install Playwright browsers once:
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

Optional iPhone-sized WebKit room E2E:
```bash
pnpm test:hls:room:webkit -- --base-url http://localhost:3101 --room demo --invite-code "..."
```

Behavior highlights:
- smoke server binds to `127.0.0.1` and browser origin is always `http://localhost:4173` (or `HLS_SMOKE_PORT`)
- room E2E canonical origin is `http://localhost:3100` (or `HLS_TEST_BASE_URL`)
- WebKit room E2E canonical origin is `http://localhost:3101`; it boots the app with `NEXT_PUBLIC_SYNC_DEBUG=true` so the real debug panel stays mounted during the UI regression suite
- strict token guard fails if unsigned URLs are public (`2xx`) or redirect (`3xx`)
- retry is one time only and only for timeout/network/5xx classes in Bunny smoke mode
- all test diagnostics redact auth query params (`token`, `bcdn_token`, `expires`, `token_path`)
- full suite requires Bunny CORS to allow `http://localhost:4173`, `http://localhost:3100`, and `http://localhost:3101`
- if room Chromium E2E fails with `MEDIA_ERR_SRC_NOT_SUPPORTED` and video source points to `.m3u8`, treat it as engine-selection/native-path regression before CORS triage
- WebKit playback assertions are capability-aware and may skip on runtimes without native HLS support; set `HLS_E2E_REQUIRE_WEBKIT_HLS=1` to turn those skips into failures on supported environments

Recommended Bunny CORS dev snippet:
- allow origins: `http://localhost:4173`, `http://localhost:3100`, `http://localhost:3101`
- allow methods: `GET, HEAD, OPTIONS`
- allow request headers: `Range`

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
