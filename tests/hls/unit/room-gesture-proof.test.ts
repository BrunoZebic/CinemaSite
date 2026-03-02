import assert from "node:assert/strict";
import test from "node:test";
import {
  captureGestureProofBaseline,
  didRunEndedBecomeSet,
  evaluateGestureProofAfterClick,
  isRunIdAdvanced,
  isTimestampAdvanced,
  type GestureProofBaseline,
  type GestureProofSnapshot,
} from "../room-gesture-proof";

function baseline(overrides: Partial<GestureProofBaseline> = {}): GestureProofBaseline {
  return {
    currentTime: 0,
    paused: true,
    footerDisplayState: null,
    startupProvenBeforeClick: false,
    overlayTapHandledCount: 0,
    gestureTapCount: 0,
    lastGestureAtMs: null,
    playAttemptRunId: null,
    playAttemptStartAtMs: null,
    startupWindowRunId: null,
    startupWindowStartAtMs: null,
    runEndedReason: null,
    primedForMountId: null,
    videoElementMountId: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GestureProofSnapshot> = {}): GestureProofSnapshot {
  return {
    currentTime: 0,
    paused: true,
    footerDisplayState: null,
    probe: null,
    ...overrides,
  };
}

test("timestamp/run-id/run-ended helpers obey explicit null/advance semantics", () => {
  assert.equal(isTimestampAdvanced(null, 10), true);
  assert.equal(isTimestampAdvanced(10, 10), false);
  assert.equal(isTimestampAdvanced(10, 9), false);
  assert.equal(isTimestampAdvanced(undefined, null), false);

  assert.equal(isRunIdAdvanced(null, 5), true);
  assert.equal(isRunIdAdvanced(5, 4), true);
  assert.equal(isRunIdAdvanced(5, 5), false);
  assert.equal(isRunIdAdvanced(undefined, null), false);

  assert.equal(didRunEndedBecomeSet(null, "play_failed"), true);
  assert.equal(didRunEndedBecomeSet("play_failed", "play_failed"), false);
  assert.equal(didRunEndedBecomeSet(null, null), false);
});

test("captureGestureProofBaseline keeps null-safe baseline shape", () => {
  const captured = captureGestureProofBaseline(
    snapshot({
      currentTime: 1.5,
      paused: false,
      footerDisplayState: "SYNCING",
      probe: {
        overlayTapHandledCount: 2,
        gestureTapCount: 3,
        lastGestureAtMs: 1000,
        playAttemptRunId: 4,
        playAttemptStartAtMs: 1001,
        startupWindowRunId: 5,
        startupWindowStartAtMs: 1002,
        runEndedReason: "play_failed",
        primedForMountId: 7,
        videoElementMountId: 7,
      },
    }),
    true,
  );

  assert.equal(captured.currentTime, 1.5);
  assert.equal(captured.paused, false);
  assert.equal(captured.footerDisplayState, "SYNCING");
  assert.equal(captured.startupProvenBeforeClick, true);
  assert.equal(captured.overlayTapHandledCount, 2);
  assert.equal(captured.playAttemptRunId, 4);
  assert.equal(captured.startupWindowRunId, 5);
  assert.equal(captured.runEndedReason, "play_failed");
});

test("artifact-like failing shape now passes via post-click startup/play attempt progression", () => {
  const base = baseline({
    currentTime: 1376.2,
    paused: false,
    startupProvenBeforeClick: false,
  });

  const after = snapshot({
    currentTime: 1376.502,
    paused: false,
    footerDisplayState: "SYNCING",
    probe: {
      playbackStartState: "CANONICAL_SEEKED",
      playIntentActive: true,
      gestureTapCount: 1,
      overlayTapHandledCount: 1,
      lastGestureAtMs: 1772412307176,
      lastPlayAttempt: "attempted",
      startupCalledFromGesture: false,
      startupWindowRunId: 1,
      startupWindowStartAtMs: 1772412309085,
      runEndedReason: null,
      playAttemptRunId: 1,
      playAttemptStartAtMs: 1772412309086,
      primedForMountId: 2,
      videoElementMountId: 2,
    },
  });

  const result = evaluateGestureProofAfterClick(base, after);
  assert.equal(result.pass, true);
  assert.equal(result.overlayTapHandledDelta >= 1, true);
  assert.equal(result.hasRunBoundSignal, true);
  assert.equal(result.attributionMissing, true);
});

test("overlay handled but no post-click outcomes fails", () => {
  const base = baseline({
    currentTime: 30,
    paused: true,
    startupWindowRunId: 7,
    startupWindowStartAtMs: 2_000,
  });

  const after = snapshot({
    currentTime: 30,
    paused: true,
    probe: {
      overlayTapHandledCount: 1,
      gestureTapCount: 1,
      startupWindowRunId: 7,
      startupWindowStartAtMs: 2_000,
      runEndedReason: null,
      playAttemptRunId: null,
      playAttemptStartAtMs: null,
    },
  });

  const result = evaluateGestureProofAfterClick(base, after);
  assert.equal(result.pass, false);
});

test("run-present playback-only evidence does not pass without run-bound signal", () => {
  const base = baseline({
    currentTime: 10,
    paused: true,
    startupWindowRunId: 5,
    startupWindowStartAtMs: 1000,
  });

  const after = snapshot({
    currentTime: 10.6,
    paused: false,
    probe: {
      overlayTapHandledCount: 1,
      gestureTapCount: 1,
      startupWindowRunId: 5,
      startupWindowStartAtMs: 1000,
      runEndedReason: null,
    },
  });

  const result = evaluateGestureProofAfterClick(base, after);
  assert.equal(result.hasPlaybackEvidence, true);
  assert.equal(result.hasRunBoundSignal, false);
  assert.equal(result.pass, false);
});

test("pre-proven advisory path passes when startup is proven before and after click", () => {
  const base = baseline({
    startupProvenBeforeClick: true,
    currentTime: 42,
    paused: true,
  });

  const after = snapshot({
    currentTime: 42,
    paused: true,
    probe: {
      overlayTapHandledCount: 1,
      playIntentActive: true,
      playbackStartState: "CANONICAL_SEEKED",
      startupWindowRunId: 9,
      startupWindowStartAtMs: 9_000,
    },
  });

  const result = evaluateGestureProofAfterClick(base, after);
  assert.equal(result.usedPreProvenAdvisoryPath, true);
  assert.equal(result.pass, true);
});
