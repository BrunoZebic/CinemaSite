# WEEK 3.5 Plan (Revised v2): Stable Chat Scroll, Compact Message Actions, Inline Control Cleanup

## Summary
This revision incorporates low-effort/high-payoff notes.
Core objectives:
1. Fix chat growth/scroll UX with a bounded viewport and smart follow.
2. Redesign message actions as compact icons near timestamp.
3. Remove confusing inline Play/Pause from non-fullscreen controls.

## Locked Decisions
1. Scroll ownership remains message-list only.
2. Desktop chat panel starts with `height: clamp(320px, 40vh, 520px)`.
3. Auto-follow model uses:
   1. `userPinnedToBottom`
   2. `isNearBottom` (48px threshold)
   3. `pendingNewCount`
4. Auto-scroll implementation uses bottom sentinel (`bottomRef`) + `scrollIntoView({ block: "end" })`.
5. Resize/content reflow handling:
   1. If `userPinnedToBottom === true`, keep anchored at bottom.
   2. If `false`, never auto-scroll; only recompute near-bottom state.
6. Icon action touch targets:
   1. Minimum `32x32` desktop.
   2. Minimum `36x36` mobile drawer.
7. Inline non-fullscreen Play/Pause button is removed; overlay play prompts remain.

## Scope
1. In scope: chat viewport and list scroll behavior, message row styling and icon actions, non-fullscreen HLS control cleanup.
2. Out of scope: backend APIs, moderation semantics, persistence behavior.

## Files To Change
1. `components/Chat/MessageList.tsx`
2. `app/globals.css`
3. `components/Video/HlsSyncPlayer.tsx`
4. Optional small adjustment in `components/Chat/ChatPanel.tsx` for wrapper classes if required.

## Test Cases and Scenarios
1. 100+ messages do not grow chat downward; list scrolls internally.
2. Desktop shows stable bounded chat height with intended density.
3. At bottom: incoming messages follow smoothly.
4. Scrolled up: incoming messages do not move viewport.
5. Jump-to-latest restores follow mode and clears pending.
6. Long-message reflow does not nudge user when not pinned.
7. Resize events keep bottom anchored only when pinned.
8. Icon actions trigger correct existing handlers.
9. Icon tap usability is acceptable in mobile drawer.
10. Inline control bar has no Play/Pause button.
11. Playback overlays still work.
12. `npm run lint` and `npm run build` pass.

## Acceptance Criteria
1. Chat scroll behavior is bounded and predictable under load.
2. Users can read older messages without forced jumps.
3. Action controls are compact, accessible, and easy to tap.
4. Non-fullscreen playback controls are less confusing.
5. No regression in moderation/chat functionality.
