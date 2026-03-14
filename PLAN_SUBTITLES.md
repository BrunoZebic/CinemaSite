# Plan: English Subtitles — Default Enabled

## Context

The player has zero subtitle support today. The goal is to add English-only subtitle rendering with a session toggle (default ON), without touching sync, ownership, or gesture/autoplay semantics. This is a standalone feature win at low risk.

HLS.js has native subtitle track support (events + properties). Safari native HLS uses the browser `textTracks` API. Both paths need to be handled.

Both `hlsAdapter.ts` and `HlsSyncPlayer.tsx` are Level 5 subsystems — subtitle logic must follow the existing coordinator model: single-owner state, generation-safe reapplication, explicit listener cleanup, no stale callbacks.

---

## Approach

### 1. `lib/video/hlsAdapter.ts` — Adapter-owned subtitle state

**New private fields:**
```
_subtitleEnabled: boolean = true       // user preference; defaults true in constructor, persists across reinit
_englishTrackIndex: number | null      // resolved after SUBTITLE_TRACKS_UPDATED (hls.js)
_englishTextTrack: TextTrack | null    // resolved after loadedmetadata (native)
_hasSubtitleTrack: boolean             // false until English track confirmed present
_subtitleTrackListener: (() => void) | null  // callback to component; mirrors setFatalListener
```

**Lifecycle reset rules:**
- At the start of every `initialize()`, before `await this.destroy()`:
  ```
  _englishTrackIndex = null
  _englishTextTrack = null
  _hasSubtitleTrack = false
  this._subtitleTrackListener?.()   // notify component: availability is now false
  ```
  Firing the listener here is the correct mechanism — it drives `setHasSubtitleTrack(false)` in the component for ALL init paths: the main effect init, recovery reinit (`reinitializeWithUrl`), and token-refresh reinit. No React-side reset is needed; the adapter is the single source of truth.
- `_subtitleEnabled` is NOT reset — persists as user preference across reinit.
- `_subtitleTrackListener` is NOT cleared in `destroy()` — it survives internal destroy/init cycles. Component is the sole owner (cleared on unmount, see §2).

**Public API additions:**
```
setSubtitleEnabled(enabled: boolean): void
getSubtitleEnabled(): boolean
hasSubtitleTrack(): boolean
setSubtitleTrackListener(cb: (() => void) | null): void   // mirrors setFatalListener pattern
```

**hls.js path — `SUBTITLE_TRACKS_UPDATED`:**

Register inside the existing hls event setup block (same lifecycle as `MANIFEST_PARSED` / `ERROR`). Cleaned up automatically by `hls.destroy()`.

```
hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_, data) => {
  if (this.isGenerationStale(generation)) return;
  const track = data.subtitleTracks.find(t =>
    t.lang === "en" || t.name?.toLowerCase().includes("english")
  );
  if (!track) return;
  this._englishTrackIndex = track.id;
  this._hasSubtitleTrack = true;
  hls.subtitleTrack = track.id;
  hls.subtitleDisplay = this._subtitleEnabled;
  this._subtitleTrackListener?.();
});
```

`setSubtitleEnabled(enabled)`:
```
this._subtitleEnabled = enabled;
if (this.hls && this._englishTrackIndex !== null) {
  this.hls.subtitleDisplay = enabled;
  if (enabled) this.hls.subtitleTrack = this._englishTrackIndex;
}
```

**Native HLS path (Safari):**

Use `addVideoListener` (generation-guarded, auto-registers cleanup in `cleanupFns`). Piggyback on the existing `loadedmetadata` listener block:

```
this.addVideoListener(video, "loadedmetadata", generation, () => {
  // ... existing metadata handling ...
  this._resolveNativeSubtitleTrack(video, generation);
});
```

`_resolveNativeSubtitleTrack(video, generation)`:
1. Scan `video.textTracks` for first English track (same matching rules).
2. If found: store ref, set `_hasSubtitleTrack = true`, apply mode, fire listener. Done.
3. If not yet populated (Safari race): add an `addtrack` listener on `video.textTracks` with a generation-guarded wrapper pushed manually to `cleanupFns`:

```
const onAddTrack = () => {
  if (this.isGenerationStale(generation)) return;
  const found = this._tryResolveTrackFromList(video.textTracks);
  if (found) {
    // remove addtrack listener eagerly via the cleanup fn stored below
    cleanup();
  }
};
const cleanup = () => video.textTracks.removeEventListener("addtrack", onAddTrack);
video.textTracks.addEventListener("addtrack", onAddTrack);
this.cleanupFns.push(cleanup);
```

`setSubtitleEnabled(enabled)` native path:
```
this._subtitleEnabled = enabled;
if (this._englishTextTrack) {
  this._englishTextTrack.mode = enabled ? "showing" : "hidden";
}
```

**Reinit safety:** `initialize()` calls `destroy()` first, draining `cleanupFns` and incrementing the generation. The internal state reset clears resolved track references. On next `SUBTITLE_TRACKS_UPDATED` / `loadedmetadata`, the track is re-resolved and preference reapplied automatically — no component involvement needed.

### 2. `components/Video/HlsSyncPlayer.tsx` — State, bridge, SILENCE suppression, UI

**React state:**
```tsx
const [subtitlesEnabled, setSubtitlesEnabled] = useState(true);  // default ON
const [hasSubtitleTrack, setHasSubtitleTrack] = useState(false);
```

**Initial preference:** `_subtitleEnabled` defaults to `true` in the adapter constructor. No change to `initialize(video, manifestUrl)` signature. The component's `subtitlesEnabled` state also starts `true`, so they are in sync by default. The SILENCE-suppression effect and toggle handler keep them in sync from there — no explicit handoff at `initialize()` time is needed.

**Subtitle track callback:** Register alongside `setFatalListener` at line 2598 — that block runs on every effect execution, including reinit, and is the correct place for per-adapter callbacks. This exactly mirrors the `setFatalListener` pattern, which is also re-set on every effect run and never cleared in the effect cleanup:
```tsx
// alongside adapter.setFatalListener(...)
adapter.setSubtitleTrackListener(() => {
  setHasSubtitleTrack(adapter.hasSubtitleTrack());
});
```
Do NOT clear the listener in the main effect's cleanup return (line 2673) — doing so would drop subtitle-availability updates after reinit, since the same adapter instance is reused and the cleanup fires on every dependency change, not just unmount.

**No explicit `hasSubtitleTrack` reset in the component.** The adapter fires the listener at the start of every `initialize()` with `_hasSubtitleTrack = false`, so the component's `setHasSubtitleTrack` is driven entirely by the adapter callback across all init paths (main effect, recovery, token refresh). The component does not need to know which path triggered reinit.

**Unmount-only cleanup** (dedicated empty-dep effect, separate from the main init effect):
```tsx
useEffect(() => {
  return () => {
    adapterRef.current?.setSubtitleTrackListener(null);
  };
}, []);
```
This is the only place the listener is cleared — on component unmount. This mirrors how a standalone `setFatalListener(null)` would work if needed, and keeps it out of the re-running effect cleanup.

**SILENCE suppression (critical — browser caption rendering is outside CSS stacking context):**
```tsx
useEffect(() => {
  const adapter = adapterRef.current;
  if (!adapter) return;
  adapter.setSubtitleEnabled(phase === "SILENCE" ? false : subtitlesEnabled);
}, [phase, subtitlesEnabled]);
```
SILENCE always wins. No other phase-specific logic needed.

**Toggle handler:**
```tsx
function handleSubtitleToggle() {
  if (phase === "SILENCE") return;
  setSubtitlesEnabled(prev => !prev);
}
```

**CC button visibility:**
- Render only when `hasSubtitleTrack && phase !== "SILENCE"`.
- `data-testid="subtitle-toggle"`, `aria-pressed={subtitlesEnabled}`.
- CSS class: `.subtitle-toggle-btn` + `.active` when enabled.
- No English track → `hasSubtitleTrack` stays `false` → button never appears.

### 3. `app/globals.css` — Minimal button styles

Add `.subtitle-toggle-btn` within the `.video-controls` block. `.active` state: slightly brighter label or underline.

### 4. `AGENTS.md` — Subsystem registry

Extend the existing Level 5 HLS row — no new row, to avoid implying a weaker future test bar:

```
| HLS playback + coordinator + subtitle toggle | `components/Video/HlsSyncPlayer.tsx`, `lib/video/hlsAdapter.ts` | Level 5 |
```

---

## Critical Files

| File | Change |
|------|--------|
| `lib/video/hlsAdapter.ts` | Private subtitle state + `SUBTITLE_TRACKS_UPDATED` listener + native `addVideoListener` + public API |
| `components/Video/HlsSyncPlayer.tsx` | `subtitlesEnabled` + `hasSubtitleTrack` state, callback registration, SILENCE-suppression effect, unmount cleanup, CC button |
| `app/globals.css` | `.subtitle-toggle-btn` styles |
| `tests/hls/unit/hls-subtitle-selection.test.ts` | New unit tests |
| `AGENTS.md` | Extend Level 5 HLS row |

---

## Testing

**Unit tests — `tests/hls/unit/hls-subtitle-selection.test.ts`** (run via `pnpm test:hls:unit`):

1. "selects English track by `lang === 'en'`" — assert `subtitleTrack = 0`, `subtitleDisplay = true`
2. "selects English track by name fallback (`lang === 'und'`)" — assert selected
3. "`setSubtitleEnabled(false)` sets `subtitleDisplay = false`"
4. "`setSubtitleEnabled(true)` restores `subtitleDisplay = true`"
5. "no English track — `hasSubtitleTrack()` returns `false`, listener called once at `initialize()` reset but never called again with a track-found state, no error thrown"
6. "preference reapplied on reinit — subtitleDisplay correct after second `SUBTITLE_TRACKS_UPDATED` (simulates recovery)"
7. "stale generation — `SUBTITLE_TRACKS_UPDATED` after `destroy()` does not fire listener or mutate state"
8. "SILENCE suppression — after `setSubtitleEnabled(false)` called for SILENCE, `subtitleDisplay = false` regardless of user preference"

**Native path unit tests (new — `hls-subtitle-selection.test.ts` native section):**

9. "native — English track resolved from `video.textTracks` on `loadedmetadata`" — mock `textTracks` with an English `TextTrack`, simulate `loadedmetadata` event via `addVideoListener`, assert `hasSubtitleTrack() === true` and `textTrack.mode = 'showing'`
10. "native — late `addtrack` resolution — textTracks empty at `loadedmetadata`, English track added via `addtrack` event" — assert `hasSubtitleTrack()` remains `false` until `addtrack` fires, then becomes `true` and `mode = 'showing'`
11. "native — `setSubtitleEnabled(false)` sets `textTrack.mode = 'hidden'`"
12. "native — `setSubtitleEnabled(true)` sets `textTrack.mode = 'showing'`"
13. "native — generation stale on `addtrack` — listener not fired after `destroy()`"

**Required gates (this PR):**
1. `pnpm lint`
2. `pnpm build`
3. `pnpm test:hls:unit` — includes new subtitle tests
4. `pnpm test:hls:bunny -- --room demo` — existing smoke harness must still pass
5. `pnpm test:hls:room:webkit -- --room demo --invite-code "<code>"` — required regression guard per repo contract (AGENTS.md §3.2); native TextTrack handling is WebKit-specific playback logic. Subtitle-specific assertions within this suite are deferred (see below), but the suite must run and pass as a baseline.

**Deferred (not required until subtitle-enabled test asset is provisioned):**
- Playwright CC visibility check in `room-playback.spec.ts` (Chromium): depends on the test room having an English subtitle track. Not added as a required gate in this PR; tracked as a follow-up.
- Playwright SILENCE hiding check: phase transitions are wall-clock driven with no deterministic host action to force SILENCE in the shared harness. SILENCE suppression is unit-tested (case 8) and verified by code review of the `phase === "SILENCE"` conditional.
- Manual sanity check: test against a known subtitle-enabled HLS manifest/room to confirm English track selection, default-on behavior, and toggle before declaring the feature complete in the field.

---

## Implementation notes (non-blocking, keep in mind during coding)

1. **Native track field names**: `_tryResolveTrackFromList` must use `TextTrack.language` and `TextTrack.label` (browser API shapes), not the hls.js `lang` / `name` property names used in the hls.js `SUBTITLE_TRACKS_UPDATED` handler.
2. **SILENCE effect ordering**: The SILENCE-suppression `useEffect` must run after the adapter ref is established on mount. Place it after the main init effect, or guard with `if (!adapterRef.current) return` as already planned — this handles the first-mount SILENCE edge case where the effect runs before any adapter exists.
3. **Unit test module mocking**: The new `tsx --test` unit tests will likely need a mock or stub for the browser-side adapter since it references `HTMLVideoElement` and `TextTrackList`. Follow the existing pattern in `hls-engine-selection.test.ts` for how client modules are imported in this test environment.

---

## Non-goals / Out of scope

- No multi-language track selection.
- No localStorage persistence (resets to ON on reload — acceptable for v1).
- No subtitle styling customization.
- No changes to sync, gesture, or phase state machine.
- No new test fixture or subtitle-enabled room provisioned in this PR.
