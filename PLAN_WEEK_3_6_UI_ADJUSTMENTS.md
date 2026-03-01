# WEEK 3.6 UI Adjustments (Revision E): Gesture CTA + WAITING Lobby Final Spec

## Summary
Implement a textless projector-rings play CTA for gesture-required playback, plus a calm WAITING lobby after priming. This revision adds a final guard: startup-state normalization must not run in degraded recovery mode.

## Locked Decisions
1. Gesture CTA appears only when `showPlayer` is true and gesture is required.
2. WAITING supports early priming.
3. After successful WAITING priming, pause on next animation frame (`requestAnimationFrame`) to avoid visible playback burst.
4. WAITING lobby is shown after priming (or when priming not required), with minimal status copy.
5. SILENCE blackout always has highest precedence.
6. `DEGRADED` overlay stays text + Retry in this iteration.
7. Muted-on-gesture-start remains enabled.

## Scope
1. In scope: `HlsSyncPlayer` overlay/state/render logic and CSS.
2. Out of scope: backend/API/types, recovery budget logic, chat behavior.

## Files Changed
1. `components/Video/HlsSyncPlayer.tsx`
2. `app/globals.css`

## Implementation Notes
1. Added derived visibility flags:
   - `isPrimingNeeded`
   - `isGestureRequired`
   - `showWaitingLobbyOverlay`
2. Added guarded PRIMING normalization effect that does not run in `DEGRADED`.
3. Replaced text prime overlay with textless gesture CTA overlay:
   - centered play button
   - 3 pulsing projector rings
   - no explanatory text
4. Added WAITING lobby overlay (`Waiting...` / `Starts soon`) with `pointer-events: none`.
5. Updated gesture tap behavior:
   - immediate `video.play()` in click handler
   - WAITING success path pauses in RAF and skips LIVE sync path
   - LIVE success path keeps canonical resync behavior
6. Added gesture overlay animation lifecycle:
   - `idle -> accepting -> exiting`
   - short dismissal timing
   - timer cleanup on state changes, SILENCE, and unmount
7. Standardized CSS classes:
   - `.video-gesture-overlay`
   - `.video-gesture-cta`
   - `.video-gesture-rings`
   - `.video-gesture-ring`
   - `.video-gesture-icon`
   - `.video-waiting-lobby`
   - `.video-recovery-overlay`
8. Added reduced-motion fallback for ring pulse animation.

## Test Cases
1. CTA never appears when `showPlayer` is false.
2. WAITING + unprimed: CTA appears.
3. WAITING + primed: CTA hidden, waiting lobby visible.
4. WAITING prime tap does not show visible playback burst.
5. LIVE blocked/unprimed: CTA appears and starts playback.
6. SILENCE suppresses CTA/lobby.
7. `DEGRADED` overlay remains unchanged and interactive.
8. Normalization effect does not fire in `DEGRADED`.
9. No max update depth warnings from normalization logic.
10. `npm run lint` and `npm run build` pass.

## Acceptance Criteria
1. Gesture CTA is textless, calm, and shown only when needed.
2. WAITING post-prime state is clearly intentional (lobby state).
3. SILENCE precedence remains correct.
4. Degraded recovery state is not overridden by normalization.
5. No regressions in startup/recovery behavior.

## Assumptions and Defaults
1. WAITING lobby copy defaults to `Waiting...` / `Starts soon`.
2. Prime pause timing uses RAF.
3. Muted-until-explicit-unmute policy remains.
4. Pulse cycle defaults to `2.8s`.
