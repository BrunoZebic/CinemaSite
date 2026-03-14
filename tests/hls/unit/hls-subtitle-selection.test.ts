/**
 * Unit tests for subtitle selection and toggle logic.
 *
 * The adapter (HlsPlaybackAdapter) has browser/hls.js dependencies that do not
 * run in Node.js. These tests verify the same behavioral contracts using
 * self-contained stubs that replicate the adapter's subtitle state machine.
 * Logic patterns must stay in sync with the implementation in hlsAdapter.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

// ---------------------------------------------------------------------------
// Minimal hls.js subtitle track shape (mirrors SubtitleTrack from hls.js)
// ---------------------------------------------------------------------------
interface HlsSubtitleTrack {
  id: number;
  lang?: string;
  name?: string;
}

// ---------------------------------------------------------------------------
// Pure helper: matches the exact selection logic in hlsAdapter._tryResolveTrackFromList
// (hls.js path uses lang/name; native path uses language/label)
// ---------------------------------------------------------------------------
function findHlsEnglishTrack(
  tracks: HlsSubtitleTrack[],
): HlsSubtitleTrack | undefined {
  return tracks.find(
    (t) => t.lang === "en" || t.name?.toLowerCase().includes("english"),
  );
}

interface NativeTextTrack {
  language?: string;
  label?: string;
  mode: "showing" | "hidden" | "disabled";
}

function findNativeEnglishTrack(
  tracks: NativeTextTrack[],
): NativeTextTrack | undefined {
  return tracks.find(
    (t) =>
      t.language === "en" || t.label?.toLowerCase().includes("english"),
  );
}

// ---------------------------------------------------------------------------
// Minimal adapter-like state machine (mirrors hlsAdapter subtitle state)
// ---------------------------------------------------------------------------
class SubtitleStateMachine {
  private _subtitleEnabled = true;
  private _englishTrackIndex: number | null = null;
  private _englishTextTrack: NativeTextTrack | null = null;
  private _hasSubtitleTrack = false;
  private _subtitleTrackListener: (() => void) | null = null;
  private _generation = 0;
  private _subtitleDisplay = false;
  private _activeSubtitleTrack = -1;

  // Simulated cleanupFns (mirrors adapter.cleanupFns)
  private _cleanupFns: Array<() => void> = [];

  setSubtitleTrackListener(cb: (() => void) | null): void {
    this._subtitleTrackListener = cb;
  }

  hasSubtitleTrack(): boolean {
    return this._hasSubtitleTrack;
  }

  setSubtitleEnabled(enabled: boolean): void {
    this._subtitleEnabled = enabled;
    if (this._englishTrackIndex !== null) {
      this._subtitleDisplay = enabled;
      if (enabled) this._activeSubtitleTrack = this._englishTrackIndex;
    }
    if (this._englishTextTrack) {
      this._englishTextTrack.mode = enabled ? "showing" : "hidden";
    }
  }

  getSubtitleEnabled(): boolean {
    return this._subtitleEnabled;
  }

  // Simulates initialize() subtitle state reset (fires before destroy in adapter)
  resetSubtitleState(): void {
    this._englishTrackIndex = null;
    this._englishTextTrack = null;
    this._hasSubtitleTrack = false;
    this._subtitleTrackListener?.();
  }

  // Simulates incrementGeneration + cleanupFns drain (destroy())
  destroy(): void {
    this._generation += 1;
    for (const fn of this._cleanupFns.splice(0)) fn();
    this._englishTrackIndex = null;
    this._englishTextTrack = null;
    this._hasSubtitleTrack = false;
    // _subtitleEnabled and _subtitleTrackListener survive
  }

  isGenerationStale(gen: number): boolean {
    return gen !== this._generation;
  }

  currentGeneration(): number {
    return this._generation;
  }

  // Simulates SUBTITLE_TRACKS_UPDATED handler
  handleHlsSubtitleTracksUpdated(
    tracks: HlsSubtitleTrack[],
    generation: number,
  ): void {
    if (this.isGenerationStale(generation)) return;
    const track = findHlsEnglishTrack(tracks);
    if (!track) return;
    this._englishTrackIndex = track.id;
    this._hasSubtitleTrack = true;
    this._activeSubtitleTrack = track.id;
    this._subtitleDisplay = this._subtitleEnabled;
    this._subtitleTrackListener?.();
  }

  // Simulates loadedmetadata + _tryResolveTrackFromList (native path)
  handleNativeLoadedMetadata(
    tracks: NativeTextTrack[],
    generation: number,
    onAddTrack?: (cb: () => void) => { remove: () => void },
  ): void {
    if (this.isGenerationStale(generation)) return;
    const found = this._tryResolveNativeTrack(tracks);
    if (found) return;
    if (!onAddTrack) return;
    // Simulate addtrack fallback
    const subscription = onAddTrack(() => {
      if (this.isGenerationStale(generation)) return;
      const resolved = this._tryResolveNativeTrack(tracks);
      if (resolved) subscription.remove();
    });
    this._cleanupFns.push(subscription.remove);
  }

  private _tryResolveNativeTrack(tracks: NativeTextTrack[]): boolean {
    const track = findNativeEnglishTrack(tracks);
    if (!track) return false;
    this._englishTextTrack = track;
    this._hasSubtitleTrack = true;
    track.mode = this._subtitleEnabled ? "showing" : "hidden";
    this._subtitleTrackListener?.();
    return true;
  }

  // Expose for assertions
  get subtitleDisplay(): boolean {
    return this._subtitleDisplay;
  }
  get activeSubtitleTrack(): number {
    return this._activeSubtitleTrack;
  }
}

// ---------------------------------------------------------------------------
// Tests — hls.js path
// ---------------------------------------------------------------------------

test("selects English track by lang === 'en'", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  let fired = 0;
  sm.setSubtitleTrackListener(() => fired++);

  sm.handleHlsSubtitleTracksUpdated(
    [{ id: 0, lang: "en", name: "English" }],
    gen,
  );

  assert.equal(sm.hasSubtitleTrack(), true);
  assert.equal(sm.subtitleDisplay, true);
  assert.equal(sm.activeSubtitleTrack, 0);
  assert.equal(fired, 1);
});

test("selects English track by name fallback when lang is 'und'", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  sm.handleHlsSubtitleTracksUpdated(
    [{ id: 2, lang: "und", name: "English (SDH)" }],
    gen,
  );

  assert.equal(sm.hasSubtitleTrack(), true);
  assert.equal(sm.activeSubtitleTrack, 2);
});

test("setSubtitleEnabled(false) sets subtitleDisplay=false", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  sm.handleHlsSubtitleTracksUpdated([{ id: 0, lang: "en" }], gen);
  assert.equal(sm.subtitleDisplay, true);

  sm.setSubtitleEnabled(false);
  assert.equal(sm.subtitleDisplay, false);
  assert.equal(sm.getSubtitleEnabled(), false);
});

test("setSubtitleEnabled(true) restores subtitleDisplay=true", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  sm.handleHlsSubtitleTracksUpdated([{ id: 0, lang: "en" }], gen);
  sm.setSubtitleEnabled(false);
  sm.setSubtitleEnabled(true);
  assert.equal(sm.subtitleDisplay, true);
  assert.equal(sm.activeSubtitleTrack, 0);
});

test("no English track — hasSubtitleTrack stays false, listener called once at reset but not again", () => {
  const sm = new SubtitleStateMachine();
  let fired = 0;
  sm.setSubtitleTrackListener(() => fired++);

  sm.resetSubtitleState(); // simulates initialize() pre-destroy notification
  assert.equal(fired, 1); // called once for reset
  assert.equal(sm.hasSubtitleTrack(), false);

  // Now SUBTITLE_TRACKS_UPDATED fires with no English track
  sm.handleHlsSubtitleTracksUpdated(
    [{ id: 0, lang: "fr", name: "French" }],
    sm.currentGeneration(),
  );
  assert.equal(fired, 1); // no additional calls
  assert.equal(sm.hasSubtitleTrack(), false);
});

test("preference reapplied on reinit — subtitleDisplay correct after second SUBTITLE_TRACKS_UPDATED", () => {
  const sm = new SubtitleStateMachine();
  let gen = sm.currentGeneration();
  sm.handleHlsSubtitleTracksUpdated([{ id: 0, lang: "en" }], gen);
  sm.setSubtitleEnabled(false);

  // Simulate reinit: reset + destroy + new generation + new event
  sm.resetSubtitleState();
  sm.destroy();
  gen = sm.currentGeneration();
  sm.handleHlsSubtitleTracksUpdated([{ id: 0, lang: "en" }], gen);

  // _subtitleEnabled persisted as false across reinit
  assert.equal(sm.subtitleDisplay, false);
  assert.equal(sm.hasSubtitleTrack(), true);
});

test("stale generation — SUBTITLE_TRACKS_UPDATED after destroy does not mutate state or fire listener", () => {
  const sm = new SubtitleStateMachine();
  const staleGen = sm.currentGeneration();
  let fired = 0;
  sm.setSubtitleTrackListener(() => fired++);

  sm.destroy(); // increments generation

  sm.handleHlsSubtitleTracksUpdated([{ id: 0, lang: "en" }], staleGen);

  assert.equal(sm.hasSubtitleTrack(), false);
  assert.equal(fired, 0);
});

test("SILENCE suppression — setSubtitleEnabled(false) overrides user preference=true", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  sm.handleHlsSubtitleTracksUpdated([{ id: 0, lang: "en" }], gen);
  assert.equal(sm.subtitleDisplay, true); // default ON

  // Component calls this when phase === SILENCE
  sm.setSubtitleEnabled(false);
  assert.equal(sm.subtitleDisplay, false);

  // Restore when leaving SILENCE (user preference was true)
  sm.setSubtitleEnabled(true);
  assert.equal(sm.subtitleDisplay, true);
});

// ---------------------------------------------------------------------------
// Tests — native path
// ---------------------------------------------------------------------------

test("native — English track resolved from textTracks on loadedmetadata", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  let fired = 0;
  sm.setSubtitleTrackListener(() => fired++);

  const tracks: NativeTextTrack[] = [
    { language: "en", label: "English", mode: "disabled" },
  ];

  sm.handleNativeLoadedMetadata(tracks, gen);

  assert.equal(sm.hasSubtitleTrack(), true);
  assert.equal(tracks[0].mode, "showing"); // default enabled
  assert.equal(fired, 1);
});

test("native — English track selected by label when language is not 'en'", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();

  const tracks: NativeTextTrack[] = [
    { language: "und", label: "English (SDH)", mode: "disabled" },
  ];

  sm.handleNativeLoadedMetadata(tracks, gen);
  assert.equal(sm.hasSubtitleTrack(), true);
  assert.equal(tracks[0].mode, "showing");
});

test("native — late addtrack resolution — empty at loadedmetadata, resolved via addtrack event", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  let fired = 0;
  sm.setSubtitleTrackListener(() => fired++);

  const tracks: NativeTextTrack[] = []; // empty initially
  let addTrackCb: (() => void) | null = null;

  // Simulate addtrack subscription
  sm.handleNativeLoadedMetadata(tracks, gen, (cb) => {
    addTrackCb = cb;
    return { remove: () => { addTrackCb = null; } };
  });

  assert.equal(sm.hasSubtitleTrack(), false); // not yet resolved
  assert.equal(fired, 0);

  // Simulate Safari adding track later
  tracks.push({ language: "en", label: "English", mode: "disabled" });
  addTrackCb?.();

  assert.equal(sm.hasSubtitleTrack(), true);
  assert.equal(tracks[0].mode, "showing");
  assert.equal(fired, 1);
  assert.equal(addTrackCb, null); // listener removed eagerly after resolution
});

test("native — setSubtitleEnabled(false) sets textTrack.mode = 'hidden'", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  const tracks: NativeTextTrack[] = [
    { language: "en", label: "English", mode: "disabled" },
  ];

  sm.handleNativeLoadedMetadata(tracks, gen);
  assert.equal(tracks[0].mode, "showing");

  sm.setSubtitleEnabled(false);
  assert.equal(tracks[0].mode, "hidden");
});

test("native — setSubtitleEnabled(true) sets textTrack.mode = 'showing'", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  const tracks: NativeTextTrack[] = [
    { language: "en", label: "English", mode: "disabled" },
  ];

  sm.handleNativeLoadedMetadata(tracks, gen);
  sm.setSubtitleEnabled(false);
  sm.setSubtitleEnabled(true);
  assert.equal(tracks[0].mode, "showing");
});

test("native — generation stale on addtrack — listener not fired after destroy()", () => {
  const sm = new SubtitleStateMachine();
  const gen = sm.currentGeneration();
  let fired = 0;
  sm.setSubtitleTrackListener(() => fired++);

  const tracks: NativeTextTrack[] = [];
  let addTrackCb: (() => void) | null = null;

  sm.handleNativeLoadedMetadata(tracks, gen, (cb) => {
    addTrackCb = cb;
    return { remove: () => { addTrackCb = null; } };
  });

  sm.destroy(); // increments generation, drains cleanupFns → removes addtrack listener

  // addTrackCb should have been removed by cleanup
  assert.equal(addTrackCb, null);
  assert.equal(sm.hasSubtitleTrack(), false);
  assert.equal(fired, 0);
});
