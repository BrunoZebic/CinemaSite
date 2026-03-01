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

1. Install dependencies:
```bash
npm install
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
npm run dev
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
- `npm run dev`
- `npm run lint`
- `npm run build`
- `npm run start`

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
