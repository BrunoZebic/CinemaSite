# PLAN_WEEK_3_CODEX

## Title
HLS Player Migration and Custom Cinema Controls

## Summary
Replace Vimeo playback with an HLS-capable custom `<video>` player while preserving the existing canonical clock, phase machine, and reconnect resync safety from Week 3.

## Goal
- Move playback provider to HLS for Screening #2 readiness.
- Keep sync semantics unchanged:
  - canonical server start time
  - phase-aware playback behavior
  - drift correction loop in `LIVE`
- Ensure cross-browser compatibility:
  - native HLS on Safari/iOS/macOS
  - `hls.js` fallback for Chrome/Edge/Firefox

## In Scope
- HLS adapter and provider routing logic
- New HLS sync player component with custom controls overlay
- Schema migration to add `video_manifest_url`
- Bootstrap and screening config updates to use manifest URL
- Rehearsal debug continuity and reconnect resync continuity

## Out of Scope
- HLS transcoding pipeline changes
- DRM integration
- Multi-audio/subtitle tracks
- Video CDN architecture redesign

## Public Interface / Type Changes
- `videoProvider`: keep `"vimeo" | "hls"`; prefer `hls` going forward.
- Add `videoManifestUrl?: string` to screening config type.
- Keep `videoAssetId` temporarily for backward compatibility.
- Update bootstrap response so clients receive final HLS manifest URL directly.

## Data / Schema Changes
- Add migration:
  - `alter table screenings add column if not exists video_manifest_url text;`
- Data rule:
  - when `video_provider = 'hls'`, `video_manifest_url` must be populated.
- Backward compatibility:
  - if `video_manifest_url` missing, fallback to `video_asset_id` only for transitional records.

## Deliverables
- `lib/video/hlsAdapter.ts`
- `components/Video/HlsSyncPlayer.tsx`
- `supabase/migrations/<timestamp>_add_video_manifest_url.sql`
- Updated `lib/premiere/types.ts`, `lib/server/screenings.ts`, bootstrap serialization
- Updated `README.md` and `.env.example`

## Implementation Plan

### 1) Adapter Layer
- Create `HlsPlaybackAdapter` implementing existing `PlaybackAdapter` contract.
- Constructor inputs:
  - `videoEl: HTMLVideoElement`
  - `manifestUrl: string`
- `initialize()`:
  - If `videoEl.canPlayType("application/vnd.apple.mpegurl")`:
    - set `videoEl.src = manifestUrl`
    - wait for `loadedmetadata` or `canplay`
  - Else:
    - instantiate `hls.js`
    - `hls.loadSource(manifestUrl)`
    - `hls.attachMedia(videoEl)`
    - wait for `MANIFEST_PARSED` and `loadedmetadata`
- `waitUntilReady(timeoutMs)`:
  - resolve only after ready event; reject on timeout.
- `seekTo(seconds)`:
  - no-op/queue or throw guarded error if not ready.
- `setPlaybackRate(rate)`:
  - assign to `videoEl.playbackRate`.
- `destroy()`:
  - detach/destroy hls.js instance, clear listeners.

### 2) Player Component
- Add `HlsSyncPlayer.tsx` as client component.
- Render:
  - `<video ref={videoRef} playsInline />`
  - custom control overlay
- Keep identical sync engine behavior from current `VideoSyncPlayer`:
  - target time from server offset + canonical start
  - clamp `[0, filmDurationSec]`
  - hard seek for drift > 2s
  - bounded soft correction window (max 5s)
  - pause + disable drift loop in `SILENCE`
  - pause/hidden in `DISCUSSION` and `CLOSED`
  - WAITING: countdown, no autoplay, preloaded paused state

### 3) Provider Routing
- Update shell/video orchestration:
  - `videoProvider === "hls"` -> render HLS player
  - `videoProvider === "vimeo"` -> keep existing Vimeo player for temporary fallback
- Add clear status if manifest URL missing.

### 4) Custom Controls (First Pass)
- Controls:
  - Play/Pause
  - Mute toggle
  - Volume slider
  - Fullscreen button
- Screening integrity rules:
  - hide scrubber during `LIVE`
  - allow scrub only in `WAITING` or `DISCUSSION` (config-gated)
- Optional keyboard shortcuts:
  - `Space` play/pause
  - `M` mute
  - `F` fullscreen

### 5) Sync Safety
- Guard all `seekTo` calls with readiness check.
- Listen for `waiting` / `stalled` and expose buffering state to debug overlay.
- On channel reconnect healthy event:
  - refetch bootstrap
  - refresh phase/chat lock
  - immediate `resyncToCanonicalTime()`
- Preserve existing reconnect idempotency guard.

### 6) Networking/CORS Expectations
- Use manifest URL exactly as stored in DB.
- No proxy layer introduced this week.
- Verify CORS and segment access from your deployment domain.

### 7) Rehearsal and Cross-Browser Tests
- Chrome desktop path uses `hls.js`.
- Safari macOS/iOS path uses native HLS.
- Two-device LIVE sync soak for 5-10 minutes.
- Refresh mid-SILENCE remains `SILENCE`.
- Simulated disconnect/reconnect triggers bootstrap refresh + immediate resync.
- Confirm chat remains unaffected by video provider swap.

## Acceptance Criteria
- HLS playback works on Safari (native) and Chrome (hls.js fallback).
- Drift correction remains stable and phase-correct.
- No autoplay during `WAITING`.
- `SILENCE` reliably pauses playback and keeps drift loop inactive.
- Reconnect flow resyncs immediately after bootstrap refresh.
- Existing invite/host/chat persistence behavior remains unchanged.

## Risks and Mitigations
- Risk: platform ignores frequent playbackRate changes.
  - Mitigation: preserve hard seek guarantee and widen/disable soft correction if needed.
- Risk: manifest/segment CORS misconfiguration.
  - Mitigation: early rehearsal with production-like URL and network conditions.
- Risk: ready-event timing differences across browsers.
  - Mitigation: strict `waitUntilReady()` with timeout and retry messaging.

## Rollout
- Week 3 deploy behind provider config:
  - enable HLS for a test room first
  - keep Vimeo as temporary fallback
- After rehearsal pass, set main screening room to `video_provider = 'hls'`.
