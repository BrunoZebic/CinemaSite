export type StartupRunEndedReason =
  | "progress_reached"
  | "play_failed"
  | "handoff_to_recovery"
  | "aborted_by_supersession"
  | "aborted_other";

export type GestureProofProbe = {
  playIntentActive?: boolean;
  playbackStartState?: string;
  gestureTapCount?: number;
  overlayTapHandledCount?: number;
  lastGestureAtMs?: number | null;
  lastPlayAttempt?: string | null;
  startupCalledFromGesture?: boolean;
  startupWindowRunId?: number | null;
  startupWindowStartAtMs?: number | null;
  runEndedReason?: StartupRunEndedReason | null;
  primedForMountId?: number | null;
  videoElementMountId?: number;
  playAttemptRunId?: number | null;
  playAttemptStartAtMs?: number | null;
};

export type GestureProofSnapshot = {
  currentTime: number;
  paused: boolean;
  footerDisplayState: string | null;
  probe: GestureProofProbe | null;
};

export type GestureProofBaseline = {
  currentTime: number;
  paused: boolean;
  footerDisplayState: string | null;
  startupProvenBeforeClick: boolean;
  overlayTapHandledCount: number;
  gestureTapCount: number;
  lastGestureAtMs: number | null;
  playAttemptRunId: number | null;
  playAttemptStartAtMs: number | null;
  startupWindowRunId: number | null;
  startupWindowStartAtMs: number | null;
  runEndedReason: StartupRunEndedReason | null;
  primedForMountId: number | null;
  videoElementMountId: number | null;
};

export type GestureProofEvaluation = {
  pass: boolean;
  overlayTapHandledDelta: number;
  startupProvenBeforeClick: boolean;
  startupProvenAfterClick: boolean;
  usedPreProvenAdvisoryPath: boolean;
  hasRunContext: boolean;
  hasRunBoundSignal: boolean;
  requiresRunBoundSignalForPlayback: boolean;
  hasPlaybackEvidence: boolean;
  hasPlaybackEvidenceAccepted: boolean;
  hasAcceptedPlayAttempt: boolean;
  hasPlayAttemptProgress: boolean;
  hasStartupWindowProgress: boolean;
  runEndedBecameSet: boolean;
  hasPrimingGestureEvidence: boolean;
  hasAnyPrimaryOutcome: boolean;
  attributionObserved: boolean;
  attributionMissing: boolean;
  supportiveFooterDisplayState: "SYNCING" | "BUFFERING" | "PLAYING" | null;
};

const STARTUP_PROVEN_STATES = new Set(["STARTING", "CANONICAL_SEEKED", "PLAYING", "BUFFERING"]);

const SUPPORTIVE_FOOTER_STATES = new Set(["SYNCING", "BUFFERING", "PLAYING"]);

function toNumberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function toRunEndedReasonOrNull(
  value: StartupRunEndedReason | null | undefined,
): StartupRunEndedReason | null {
  return typeof value === "string" ? value : null;
}

export function isStartupProvenByProbe(probe: GestureProofProbe | null): boolean {
  if (!probe) {
    return false;
  }
  if (probe.playIntentActive !== true) {
    return false;
  }
  if (
    probe.playbackStartState === "PRIMING_REQUIRED" ||
    probe.playbackStartState === "BLOCKED_AUTOPLAY"
  ) {
    return false;
  }
  return STARTUP_PROVEN_STATES.has(probe.playbackStartState ?? "");
}

export function hasAcceptedPlayAttempt(probe: GestureProofProbe | null): boolean {
  const attempt = probe?.lastPlayAttempt ?? "";
  return attempt === "video_play_ok" || /^video_play_failed:/.test(attempt);
}

export function isTimestampAdvanced(
  base: number | null | undefined,
  post: number | null | undefined,
): boolean {
  if (post === null || post === undefined) {
    return false;
  }
  return base === null || base === undefined || post > base;
}

export function isRunIdAdvanced(
  base: number | null | undefined,
  post: number | null | undefined,
): boolean {
  if (post === null || post === undefined) {
    return false;
  }
  return base === null || base === undefined || post !== base;
}

export function didRunEndedBecomeSet(
  base: StartupRunEndedReason | null | undefined,
  post: StartupRunEndedReason | null | undefined,
): boolean {
  return (base === null || base === undefined) && post !== null && post !== undefined;
}

export function captureGestureProofBaseline(
  snapshot: GestureProofSnapshot,
  startupProvenBeforeClick: boolean,
): GestureProofBaseline {
  const probe = snapshot.probe;
  return {
    currentTime: snapshot.currentTime,
    paused: snapshot.paused,
    footerDisplayState: snapshot.footerDisplayState,
    startupProvenBeforeClick,
    overlayTapHandledCount: probe?.overlayTapHandledCount ?? 0,
    gestureTapCount: probe?.gestureTapCount ?? 0,
    lastGestureAtMs: toNumberOrNull(probe?.lastGestureAtMs),
    playAttemptRunId: toNumberOrNull(probe?.playAttemptRunId),
    playAttemptStartAtMs: toNumberOrNull(probe?.playAttemptStartAtMs),
    startupWindowRunId: toNumberOrNull(probe?.startupWindowRunId),
    startupWindowStartAtMs: toNumberOrNull(probe?.startupWindowStartAtMs),
    runEndedReason: toRunEndedReasonOrNull(probe?.runEndedReason),
    primedForMountId: toNumberOrNull(probe?.primedForMountId),
    videoElementMountId: toNumberOrNull(probe?.videoElementMountId),
  };
}

export function evaluateGestureProofAfterClick(
  baseline: GestureProofBaseline,
  snapshot: GestureProofSnapshot,
): GestureProofEvaluation {
  const probe = snapshot.probe;
  const overlayTapHandledDelta = (probe?.overlayTapHandledCount ?? 0) - baseline.overlayTapHandledCount;
  const overlayHandled = overlayTapHandledDelta >= 1;

  const hasAcceptedPlay = hasAcceptedPlayAttempt(probe);
  const hasPlayAttemptProgress =
    isTimestampAdvanced(baseline.playAttemptStartAtMs, probe?.playAttemptStartAtMs) ||
    isRunIdAdvanced(baseline.playAttemptRunId, probe?.playAttemptRunId);
  const hasStartupWindowProgress =
    isTimestampAdvanced(baseline.startupWindowStartAtMs, probe?.startupWindowStartAtMs) ||
    isRunIdAdvanced(baseline.startupWindowRunId, probe?.startupWindowRunId);
  const runEndedBecameSet = didRunEndedBecomeSet(
    baseline.runEndedReason,
    toRunEndedReasonOrNull(probe?.runEndedReason),
  );

  const primedForCurrentMount =
    probe?.primedForMountId !== null &&
    probe?.primedForMountId !== undefined &&
    probe.videoElementMountId !== undefined &&
    probe.primedForMountId === probe.videoElementMountId;
  const hasPrimingGestureEvidence =
    primedForCurrentMount && isTimestampAdvanced(baseline.lastGestureAtMs, probe?.lastGestureAtMs);

  const hasPlaybackEvidence =
    snapshot.paused === false &&
    (snapshot.currentTime > baseline.currentTime + 0.25 ||
      (baseline.currentTime <= 0.25 && snapshot.currentTime > 0.25));

  const hasRunContext =
    baseline.startupWindowRunId !== null || typeof probe?.startupWindowRunId === "number";
  const hasRunBoundSignal = hasPlayAttemptProgress || hasStartupWindowProgress || runEndedBecameSet;
  const hasPlaybackEvidenceAccepted = hasPlaybackEvidence && (!hasRunContext || hasRunBoundSignal);

  const startupProvenAfterClick = isStartupProvenByProbe(probe);
  const usedPreProvenAdvisoryPath =
    overlayHandled && baseline.startupProvenBeforeClick && startupProvenAfterClick;

  const hasAnyPrimaryOutcome =
    hasPlayAttemptProgress ||
    hasStartupWindowProgress ||
    runEndedBecameSet ||
    hasPrimingGestureEvidence ||
    hasPlaybackEvidenceAccepted;

  const attributionObserved =
    Boolean(probe?.startupCalledFromGesture) && (probe?.gestureTapCount ?? 0) >= 1;

  const supportiveFooterDisplayState =
    snapshot.footerDisplayState !== null && SUPPORTIVE_FOOTER_STATES.has(snapshot.footerDisplayState)
      ? (snapshot.footerDisplayState as "SYNCING" | "BUFFERING" | "PLAYING")
      : null;

  const pass = overlayHandled && (hasAnyPrimaryOutcome || usedPreProvenAdvisoryPath);

  return {
    pass,
    overlayTapHandledDelta,
    startupProvenBeforeClick: baseline.startupProvenBeforeClick,
    startupProvenAfterClick,
    usedPreProvenAdvisoryPath,
    hasRunContext,
    hasRunBoundSignal,
    requiresRunBoundSignalForPlayback: hasRunContext,
    hasPlaybackEvidence,
    hasPlaybackEvidenceAccepted,
    hasAcceptedPlayAttempt: hasAcceptedPlay,
    hasPlayAttemptProgress,
    hasStartupWindowProgress,
    runEndedBecameSet,
    hasPrimingGestureEvidence,
    hasAnyPrimaryOutcome,
    attributionObserved,
    attributionMissing: pass && !attributionObserved,
    supportiveFooterDisplayState,
  };
}

export function hasNonAttributionStartupOutcome(snapshot: GestureProofSnapshot): boolean {
  const probe = snapshot.probe;
  const primedForCurrentMount =
    probe?.primedForMountId !== null &&
    probe?.primedForMountId !== undefined &&
    probe.videoElementMountId !== undefined &&
    probe.primedForMountId === probe.videoElementMountId;

  return (
    hasAcceptedPlayAttempt(probe) ||
    isTimestampAdvanced(null, probe?.playAttemptStartAtMs) ||
    isRunIdAdvanced(null, probe?.playAttemptRunId) ||
    isTimestampAdvanced(null, probe?.startupWindowStartAtMs) ||
    isRunIdAdvanced(null, probe?.startupWindowRunId) ||
    didRunEndedBecomeSet(null, toRunEndedReasonOrNull(probe?.runEndedReason)) ||
    primedForCurrentMount ||
    (!snapshot.paused && snapshot.currentTime > 0.2)
  );
}
