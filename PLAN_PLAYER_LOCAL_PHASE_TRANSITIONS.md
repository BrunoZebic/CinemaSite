# Plan: Player-Local Phase Transitions With Shorter Room Chrome

## Summary
- Keep the room shell phase-aware, but make the obvious test-long transition happen inside the player viewport itself.
- Decouple room transition timing from player transition timing so the exaggerated effect belongs to the player, while header/chat/page layout return to a normal subtle duration.
- Preserve all existing phase authority, playback gating, chat rules, fullscreen ownership, and SILENCE precedence.

## Key Changes
- Add two separate timing constants in the presentation layer:
  - `ROOM_PHASE_TRANSITION_DURATION_MS` for shell/header/chat/page treatment
  - `PLAYER_PHASE_TRANSITION_DURATION_MS` for the in-player ritual transition
- Keep `lib/premiere/presentation.ts` pure and add `lib/premiere/use-phase-transition.ts` with `"use client"` for `usePhaseTransition(phase, durationMs)`.
- Use the hook independently in `PremiereShell`, `HlsSyncPlayer`, and `VideoSyncPlayer`.
- Keep `PremiereShell` as the room-shell owner only:
  - it still exposes `data-transition-kind` and `data-phase-visual-state`
  - it no longer acts as the primary timing source for the player overlay
- Add player-local attrs on `video-presentation-shell` in both players:
  - `data-player-transition-kind="none|to-live|to-silence|to-discussion|to-closed"`
  - `data-player-phase-visual-state="steady|transitioning"`
- Keep `data-screen-visual-state` as the steady-state treatment attribute and move player overlay/blackout selectors onto the new player attrs.
- Keep room-shell selectors focused on room chrome/background/header/chat behavior and land the CSS migration atomically so player transitions never disappear mid-change.
- Ensure the HLS fullscreen presentation shell carries the same player-local attrs so fullscreen still shows the in-player transition correctly.

## Validation
- `pnpm lint`
- `pnpm build`
- `pnpm test:hls:bunny -- --room demo`
- `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
- `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
