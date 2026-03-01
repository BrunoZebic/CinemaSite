# PLAN_WEEK_2_CODEX

## Goal
Upgrade the Week 1 prototype into Screening #1 operational infrastructure with server authority, access control, moderation, and reliable sync behavior.

## Scope
- Invite-only room access
- Host passphrase authorization
- Server bootstrap and canonical time endpoints
- Persisted messages and host actions
- Expanded premiere phases:
  - `WAITING`, `LIVE`, `SILENCE`, `DISCUSSION`, `CLOSED`
- Vimeo sync with drift correction
- Realtime channel watchdog and reconnect flow

## Core Server APIs
- `GET /api/time`
- `GET /api/rooms/[room]/bootstrap`
- `POST /api/rooms/[room]/access`
- `POST /api/rooms/[room]/host-auth`
- `GET /api/rooms/[room]/messages`
- `POST /api/rooms/[room]/messages`
- `POST /api/rooms/[room]/host-actions`

## Security Model
- Anon key in client for public realtime behavior
- Service role key used server-side only
- Signed HttpOnly cookies for room access and host privilege
- Server-side validation for invite/passphrase/message writes
- Production safety gate:
  - `ROOM_COOKIE_SECRET` required in production

## Playback and Phase Rules
- Canonical start timestamp from server config
- Server-offset clock on clients
- `targetTimeSec` clamped to `[0, filmDurationSec]`
- `LIVE`:
  - drift loop active
  - hard seek when drift > 2s
  - bounded soft correction window
- `SILENCE`:
  - black screen
  - player paused
  - drift loop disabled

## Reliability Behaviors
- Realtime health watchdog every 30s
- Backoff reconnect when unhealthy
- On healthy reconnect:
  - bootstrap refetch
  - phase/chat lock refresh
  - immediate `resyncToCanonicalTime()`

## Data Layer
- `screenings`
- `room_messages`
- `host_actions`

## Acceptance Criteria
- Invite gate blocks unauthorized attendees
- Host actions propagate and persist
- Mid-silence refresh remains in `SILENCE`
- Reconnect performs phase refresh + resync
- Build and lint pass with production route integrity
