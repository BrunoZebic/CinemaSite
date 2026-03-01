# PLAN_WEEK_4_2_REVISED

## Scope Implemented
This record captures implementation of the Week 4.2 revised plan for the LIVE reload + delayed-enable startup deadlock in `HlsSyncPlayer` and the room E2E anti-stuck harness updates.

## Code Changes

### 1) `HlsSyncPlayer.tsx`
File: `components/Video/HlsSyncPlayer.tsx`

Implemented:
1. Removed reinitialize status hijack:
- Deleted `announce` support from `reinitializeWithUrl(...)` options.
- Removed `if (options?.announce) setStatusIfChanged(...)`.
- Removed all `announce:` callsites for startup refresh, preemptive refresh, recovery, and manual retry reinit calls.

2. Enforced refresh status ownership through resolver:
- No direct `setStatusIfChanged("Refreshing stream token...")` remains.
- Refresh/recovery text now comes from `resolveOwnedStatusText(...)` owner/state logic.

3. Startup gesture-aware refresh matrix:
- Added `fromGesture?: boolean` to canonical startup options/ref types.
- In `handleOverlayPlaybackTap`, canonical startup now runs with `{ forceHardSeek: true, fromGesture: true }`.
- In startup refresh decision:
  - uses `STARTUP_ON_DEMAND_REFRESH_THRESHOLD_MS` explicitly.
  - near-expiry or auth-recent + gesture path: marks pending token refresh and continues startup (no immediate reinit).
  - expired token (`msUntilExpiry <= 0`) path: performs immediate serialized token refresh/reinit.

4. Priming reassert tightening:
- `PRIMING_REQUIRED` effect now only asserts from true-idle eligible conditions:
  - show player
  - phase in WAITING/LIVE
  - recovery not degraded
  - requires priming and `playPrimedRef.current === false`
  - `playbackStartState === "IDLE"`
  - `operationOwnerRef.current === "none"`
  - `!reinitLockRef.current`
  - `!gestureTapInFlightRef.current`
  - `!playIntentRef.current`

5. Preserved serialized reinit and pending behavior:
- Recovery-over-refresh pending priority and pending aging logic remain intact.

### 2) Room E2E anti-stuck pre-gate
File: `tests/hls/room-playback.spec.ts`

Implemented:
1. Added `STARTUP_PRE_GATE_TIMEOUT_MS` (default `12000`).
2. Added `assertPlaybackNotStuck(page)` pre-gate.
3. Pre-gate polls the actual `<video data-testid="hls-video">` element and requires:
- `readyState >= 2` OR `currentTime > 0.2` within timeout.
4. Applied pre-gate immediately after gesture click and before the existing `currentTime > 1` progression gate.

## Validation Results

Commands run:
1. `pnpm lint` -> PASS
2. `pnpm build` -> PASS
3. `pnpm test:hls:bunny -- --room demo` -> PASS
4. `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --invite-code "$HLS_TEST_INVITE_CODE"` -> FAIL

Room E2E failure summary:
- Test 1 failed at new anti-stuck pre-gate.
- Test 2 failed at playback progression (`currentTime > 1` timeout).

Observed failure-state signatures from snapshots:
- `readyState: 0`
- `playerTime/currentTime: 0`
- `playbackStartState: IDLE` (first failure) or `PRIMING_REQUIRED` (second failure)
- `playIntentActive: false`
- `recoveryState: IDLE/RECOVERING`
- `lastErrorClass: NETWORK_OR_PARSE`
- `readinessStage: MANIFEST_LOADING/ERROR`
- Status note seen as `Reconnecting stream... (sync idle)` and `Tap to enable playback. (sync idle)`

## Decision Notes
1. Week 4.2 planned behavior has been implemented in code.
2. The regression harness now catches the startup deadlock earlier and with a clearer signal.
3. Additional follow-up debugging is still required to fully resolve the runtime deadlock in room LIVE flow.
