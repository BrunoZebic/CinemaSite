# Week 4.5 Phase Ritual UX + Player-Centric Fullscreen

## Summary
- Keep this pass focused on ritual presentation and player framing, while explicitly allowing one small screening-data addition for posters.
- Fullscreen stays player-centric only: fullscreen the player presentation shell, not the whole room layout. Chat-in-fullscreen remains out of scope.
- Preserve existing phase authority and playback semantics: no changes to `computePremierePhase()`, canonical time, drift correction, chat permission rules, or adapter contracts.
- Add nullable per-screening poster support so `DISCUSSION` and `CLOSED` can resolve into a poster-backed presentation when configured.

## Data And Interfaces
- Add `posterImageUrl?: string | null` to `ScreeningConfig` in `lib/premiere/types.ts`.
- Add `poster_image_url` to the `screenings` table in both `supabase/schema.sql` and a new forward-only Supabase migration.
- Extend `ScreeningRow` and `mapScreening()` in `lib/server/screenings.ts` to map `poster_image_url -> posterImageUrl`.
- Keep `posterImageUrl` in the client-safe payload:
  - `sanitizeScreeningForClient()` must explicitly preserve it.
  - It is public presentation data and must not be stripped like manifest fields.
- Keep poster loading generic:
  - production may point `posterImageUrl` at Bunny-hosted media
  - v1 does not add Bunny-specific poster signing logic
  - render via regular `<img>` in the presentation layer, not `next/image`
- Define the presentation/test attribute enums up front:
  - `data-phase-visual-state="steady|transitioning"`
  - `data-transition-kind="none|to-live|to-silence|to-discussion|to-closed"`
  - `data-screen-visual-state="waiting-static|live-motion|silence-black|discussion-poster|discussion-static|closed-poster|closed-static"`
  - `data-chat-visual-state="dimmed|hidden|bright|muted"`

## Key Changes
- In `PremiereShell`, replace the current phase styling shortcut with attribute-driven presentation state:
  - root gets `data-testid="premiere-shell"`, `data-phase`, `data-phase-visual-state`, and `data-transition-kind`
  - chat container styling is driven from the shell-level semantic state
  - `DISCUSSION` no longer shares the same visual treatment bucket as `LIVE`
- Split player rendering in both `HlsSyncPlayer` and `VideoSyncPlayer` into:
  - a persistent presentation shell
  - a conditional active playback surface
- Rendering rule:
  - the presentation shell renders whenever the room has a scheduled screening and the user has access
  - the active playback surface is only mounted/shown for `WAITING`, `LIVE`, and `SILENCE`
  - `DISCUSSION` and `CLOSED` render presentation states inside the same shell instead of falling back to plain text-only frames
- Add layered structure inside the player shell:
  - playback layer
  - poster/still layer
  - transition overlay layer
  - gesture/recovery/control chrome layer
- WAITING rule is explicit:
  - do not implement canvas capture or frame extraction
  - for HLS/Vimeo, use the provider’s naturally visible paused-at-start frame if available
  - otherwise fall back to the static waiting treatment in the presentation layer
- Phase behavior:
  - `WAITING`: static/paused screen treatment, visually dimmed chat
  - `WAITING -> LIVE`: countdown recedes, chat dims further, overlay performs a brief black pulse, then moving image takes over
  - `LIVE -> SILENCE`: moving image yields to true black, controls/chrome disappear, chat becomes hidden
  - `SILENCE -> DISCUSSION`: black holds briefly, chat returns bright, discussion screen resolves to poster if configured or a calm static fallback if not
  - `DISCUSSION -> CLOSED`: composer disappears, chat becomes muted, screen resolves to a neutral end-state using poster when configured
- `WAITING` chat dimming is presentation-only; send permissions continue to be governed by `isChatOpenForPhase()` and are unchanged.
- Fullscreen behavior in `HlsSyncPlayer`:
  - move fullscreen ownership from the raw `<video>` element to the player presentation shell where standard fullscreen APIs exist
  - preserve native WebKit/iOS fullscreen fallback
  - track fullscreen state with cleanup-safe `fullscreenchange` listeners and expose `data-player-fullscreen`
- Overlay precedence:
  - `SILENCE` blackout always wins, including in fullscreen
  - gesture overlay remains eligible only in `WAITING` and `LIVE`
  - gesture overlay is suppressed in `SILENCE`, `DISCUSSION`, and `CLOSED`, regardless of fullscreen state
  - gesture overlay remains inside the presentation shell so it still works correctly if fullscreen is entered around the same interaction flow
- Add a local poster fixture under `public/` for deterministic tests and demo fallback use.

## Test Plan
- Extend `tests/hls/phase-transition-ui.spec.ts` with semantic assertions for:
  - shell phase attrs and transition-kind values
  - player `data-screen-visual-state`
  - chat `data-chat-visual-state`
  - `WAITING -> LIVE`
  - `LIVE -> SILENCE`
  - `SILENCE -> DISCUSSION`
  - `DISCUSSION -> CLOSED`
- Extend the phase suite helper layer:
  - add poster read/update helpers to `scripts/hls/ciRoomHelper.ts`
  - seed `poster_image_url` to the local poster fixture for poster-specific assertions
  - restore the prior value in cleanup
- Add late-joiner state assertions:
  - `LIVE` shows `live-motion` + dimmed chat
  - `SILENCE` shows `silence-black` + hidden chat
  - `DISCUSSION` shows `discussion-poster` or `discussion-static` + bright chat
  - `CLOSED` shows `closed-poster` or `closed-static` + muted chat
- Extend Chromium room playback coverage to assert:
  - `fullscreen-toggle` enters/exits fullscreen on the player presentation shell
  - `data-player-fullscreen` updates correctly
  - `SILENCE` still suppresses conflicting chrome in fullscreen
- Keep tests state-based only; do not add screenshot or pixel-diff checks in this pass.
- Required validation gates:
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test:hls:bunny -- --room demo`
  - `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --invite-code "<code>" --project room-e2e-chromium`
  - `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --invite-code "<code>" --project room-e2e-chromium`

## Assumptions
- `posterImageUrl` is optional and must never block playback, room load, or phase rendering.
- The poster is presentation-only, not an archive feature: no transcript, replay, or metadata archive work is included here.
- Chat remains outside fullscreen in this pass.
- `SILENCE` blackout in fullscreen applies to HLS only; `VideoSyncPlayer`/Vimeo fullscreen is browser-native and is not modified in this pass.
- No scripted audio fade is included.
- Phase-transition UI remains Level 4 and HLS playback remains Level 5; this work strengthens coverage without changing maturity classification.
