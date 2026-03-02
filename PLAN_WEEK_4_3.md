# PLAN_WEEK_4_3

## Scope Implemented
This file records the implemented Week 4.3 consolidated work:
- single-flight LIVE startup coordination in `HlsSyncPlayer`
- deterministic suppression/supersession behavior
- mount-bound priming lifecycle
- adapter lifecycle/generation diagnostics
- room E2E causal gesture proof and redacted diagnostics

## Code Changes

### 1) LIVE startup coordinator and run model
File: `components/Video/HlsSyncPlayer.tsx`

Implemented:
1. Added explicit startup source model:
- `gesture`
- `recovery_retry`
- `reinit_token_refresh`
- `resume`
- `phase_auto_bootstrap`

2. Added run-window state and invariants:
- `startupWindowRunId`
- `startupWindowStartAtMs`
- `startupWindowEndAtMs`
- `runEndedReason`
- `lastAbortCause`
- `playAttemptRunId`
- `playAttemptStartAtMs`

3. Added suppression model:
- `startupSuppressedReason="priming_required"` for non-gesture under priming gate
- `startupSuppressedReason="already_active_run"` for equivalent lower/equal-priority active runs
- startup source priority order enforced:
  `gesture > recovery_retry > reinit_token_refresh > resume > phase_auto_bootstrap`

4. Routed LIVE startup-capable entrypoints through the coordinator path:
- bootstrap LIVE start
- phase/live auto start
- gesture CTA start
- pause/resume live restart
- reinit/token-refresh restart
- recovery retry restart

5. Added run terminal handling:
- `progress_reached`
- `play_failed`
- `handoff_to_recovery`
- `aborted_by_supersession`
- `aborted_other`

6. Added progress gate coupling to active run:
- run progress end requires `currentTime > 0.25`
- and either `!paused` or run-attributed `playing` event observed

### 2) Priming and video element identity
File: `components/Video/HlsSyncPlayer.tsx`

Implemented:
1. Removed sessionStorage priming persistence.
2. Added mount-bound priming:
- `videoElementMountId`
- `videoRefAssignedAtMs`
- `primedForMountId`
- `isPrimed` derives from current mount identity
3. Preserved Week 3 precedence:
- `requiresPriming && !isPrimed => PRIMING_REQUIRED`
4. Non-gesture auto-start is suppressed in `PRIMING_REQUIRED`.

### 3) Gesture causality and diagnostics probes
Files:
- `components/Video/HlsSyncPlayer.tsx`
- `components/Video/types.ts`

Implemented probe fields:
- `autoplayBlocked`, `playIntentActive`, `operationOwner`, `reinitLocked`, `pendingReinitReason`
- `requiresPriming`, `isPrimed`, `primedForMountId`
- `gestureTapCount`, `overlayTapHandledCount`, `lastGestureAtMs`
- `lastPlayAttempt`, `startupCalledFromGesture`
- `pauseCount`, `lastPauseReason`
- `startupRunStartedCount`, `startupRunAbortedCount`
- `startupWindowRunId`, `startupWindowStartAtMs`, `startupWindowEndAtMs`
- `runEndedReason`, `lastAbortCause`, `startupSuppressedReason`
- `playAttemptRunId`, `playAttemptStartAtMs`
- `doubleStartSuspected`, `suppressedThenTappedSuspected`

### 4) Adapter generation and lifecycle counters
File: `lib/video/hlsAdapter.ts`

Implemented:
1. Added `adapterGenerationId` that increments on initialize/destroy lifecycle transitions.
2. Guarded adapter callbacks against stale generation.
3. Added exported lifecycle snapshot:
- `hlsInstanceId`
- `attachCount`
- `detachCount`
- `srcSetCount`
- `loadCalledCount`
- `adapterGenerationId`
4. Added deterministic counter increments for attach/detach/src/load paths.

### 5) Room E2E causal handshake updates
File: `tests/hls/room-playback.spec.ts`

Implemented:
1. Extended `RuntimeProbeState` to include run/suppression/lifecycle fields.
2. Kept race branches:
- `cta_clicked`
- `cta_not_required`
3. For `cta_clicked`, post-click proof now requires:
- `overlayTapHandledCount >= 1`
- accepted milestone (`video_play_ok` or `video_play_failed:*`) or `startupCalledFromGesture`
- run outcome signal (`startupWindowRunId` defined, or `primedForMountId===videoElementMountId`, or terminal `runEndedReason`)
4. Kept trial-click diagnostics and redacted failure artifacts.
5. Added regression assertion for `suppressedThenTappedSuspected`.

## Acceptance Criteria Status
1. Room E2E tests pass without `HLS_E2E_FORCE_GESTURE_CLICK`: PASS
2. Bunny smoke remains passing: PASS
3. LIVE startup entrypoints are coordinator-routed: PASS
4. Run/window diagnostics emitted in failure artifacts: PASS
5. Supersession clears old run metadata before next run metadata: PASS
6. Snapshot-based churn diagnostics are emitted: PASS
7. Redacted diagnostics are used for both attach and file artifacts: PASS

## Validation Results
Commands run:
1. `corepack pnpm lint` -> PASS
2. `corepack pnpm build` -> PASS
3. `corepack pnpm test:hls:bunny -- --room demo` -> PASS
4. `corepack pnpm test:hls:room -- --base-url http://localhost:3100 --room demo` -> PASS

## Notes
1. `doubleStartSuspected` remains a diagnostic classifier; thresholds/conditions can be tuned with additional CI samples.
2. `suppressedThenTappedSuspected` is present in probe output and currently guarded to avoid false positives in passing runs.

## Week 4.3.1 Footer Status Alignment (March 2, 2026)

### Scope Implemented
Footer status rendering under the HLS player is now aligned with the Week 4.3 state machine by deriving display text from coordinator-facing state rather than legacy mutable status text.

### Implemented Changes
1. Added footer display enum + mapping helpers in `components/Video/HlsSyncPlayer.tsx`:
- `FooterDisplayState`
- `deriveFooterDisplayState(...)`
- `footerDisplayStateToText(...)`
2. Footer derivation now treats `playbackStartState` as authoritative for action-needed states:
- `PRIMING_REQUIRED`, `BLOCKED_AUTOPLAY`, `STARTING`, `CANONICAL_SEEKED`, `BUFFERING`, `PLAYING`
3. Added guarded `WAITING_PRIMED` display branch:
- `phase === "WAITING" && isPrimed && playbackStartState === "IDLE"`
4. Footer rendering no longer uses legacy composed output:
- removed `"(sync idle)"`
- removed appended `"(buffering)"`
5. Footer now exposes stable E2E hooks:
- `data-testid="video-status-note"`
- `data-footer-display-state="<enum>"`
6. Added inline maintenance comment near footer render:
- footer is derived; legacy `statusText` is retained for compatibility/debug flows.
7. Room E2E coverage updated in `tests/hls/room-playback.spec.ts`:
- footer text + enum read from DOM diagnostics
- probe-to-footer alignment assertions with hybrid strictness
- explicit legacy-copy ban condition tied to run/window/startup state

### Acceptance Criteria Status (Week 4.3.1)
1. Footer derived from `FooterDisplayState` instead of `statusText`: PASS
2. Priming/autoplay footer messaging driven by `playbackStartState`: PASS
3. `WAITING_PRIMED` only under guarded condition (`WAITING + primed + IDLE`): PASS
4. Footer never contains `sync idle`: PASS
5. Footer no longer shows legacy not-ready text after explicit post-idle conditions: PASS
6. Room E2E with footer alignment checks: PASS
7. Bunny smoke remains passing: PASS

### Validation Results (Week 4.3.1)
Commands run:
1. `corepack pnpm lint` -> PASS
2. `corepack pnpm build` -> PASS
3. `corepack pnpm test:hls:bunny -- --room demo` -> PASS
4. `$env:HLS_TEST_INVITE_CODE='myInviteCode'; corepack pnpm test:hls:room -- --base-url http://localhost:3100 --room demo` -> PASS
