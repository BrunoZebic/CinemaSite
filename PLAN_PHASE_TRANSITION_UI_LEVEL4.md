# Plan: Phase Transition UI Level 4 Upgrade

## Summary
- Upgrade the phase-transition subsystem to Level 4, focused on `WAITING -> LIVE` and `SILENCE` precedence.
- Add a dedicated `pnpm test:hls:phase` command and run it in the existing preview/nightly room-E2E CI flow after playback verification.

## Key Changes
- Update `AGENTS.md`:
  - rename the registry row to `Phase transition UI + SILENCE precedence`
  - move it from Level 3 to Level 4
  - add a required gate rule for changes to `lib/premiere/phase.ts` or phase-gated room UI
- Keep command naming aligned with the repo:
  - add `package.json` script `test:hls:phase`
  - extend `scripts/hls/runRoomE2E.ts` with optional `--spec`
  - default `--spec` remains `tests/hls/room-playback.spec.ts`
  - `test:hls:phase` invokes the same runner with `--spec tests/hls/phase-transition-ui.spec.ts`
- Add `scripts/hls/ciRoomHelper.ts`
  - export `getCiRoomConfig(room)` for timing reads
  - export `resetCiRoomStart(room, startOffsetSec)` for deterministic phase positioning
  - keep `scripts/hls/resetCiRoom.ts` as the CLI wrapper
- Add stable phase UI hooks:
  - `PremiereShell`: `data-testid="phase-badge"` with `data-phase`, and `data-testid="phase-countdown"` with `data-countdown-label`
  - `ChatPanel`: `data-testid="chat-panel"` with `data-chat-open` and `data-chat-phase`
  - `Composer`: `data-testid="chat-composer-input"`
  - `HlsSyncPlayer` and `VideoSyncPlayer`: `data-testid="waiting-lobby-overlay"` and `data-testid="silence-blackout"`

## Phase Suite
- Add `tests/hls/phase-transition-ui.spec.ts`
- Bypass non-phase setup:
  - obtain invite access through `/api/rooms/[room]/access`
  - seed identity before first navigation with `page.addInitScript()` writing `premiere.identity.v1`
  - fixed identity payload:
    - `nickname: "PhaseTester"`
    - `avatarSeed: "phase-e2e-seed"`
    - `createdAt: 1700000000000`
- Test `WAITING -> LIVE`
  - reset the room to `+60s`
  - assert `WAITING`, `Starts in`, and closed chat
  - model `gesture_required` vs `gesture_not_required`
  - wait for `LIVE`, then assert `Silence in`, no waiting overlay, and open chat
- Test `LIVE -> SILENCE`
  - require `filmDurationSec >= 60`
  - reset so `SILENCE` begins in `45s`
  - confirm initial `LIVE`
  - wait for `SILENCE`
  - assert blackout/chat-lock/overlay suppression/footer state
  - POST a message during `SILENCE` and require `403`
- Suite rules:
  - use `expect.poll` and state-based assertions only
  - attach redacted diagnostics on failure
  - best-effort `afterAll` cleanup reset to `+120s`

## CI and Docs
- Update preview and nightly workflows to run `pnpm test:hls:phase` after room playback.
- Document `pnpm test:hls:phase` and the new Level 4 phase gate in `README.md`.

## Test Plan
- `pnpm lint`
- `pnpm build`
- `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
- `pnpm test:hls:bunny -- --room demo`
- `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`

## Assumptions
- The shared CI room remains the existing HLS room and must provide at least `60s` of film duration.
- Server-side `403` during `SILENCE` already exists and is being locked in as regression coverage.
- The phase suite intentionally bypasses invite/identity UI because invite flow coverage already exists elsewhere.
