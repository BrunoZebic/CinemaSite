import type { PremierePhase } from "@/lib/premiere/types";
import type { HlsPlaybackEngine } from "@/lib/video/hlsEngineSelection";

export type HlsRecoveryState = "IDLE" | "RECOVERING" | "DEGRADED";

export type HlsRecoveryErrorClass =
  | "AUTH_SUSPECTED"
  | "NETWORK_OR_PARSE"
  | "MEDIA_STALL";

export type PlaybackStartState =
  | "IDLE"
  | "PRIMING_REQUIRED"
  | "STARTING"
  | "CANONICAL_SEEKED"
  | "PLAYING"
  | "BUFFERING"
  | "BLOCKED_AUTOPLAY"
  | "DEGRADED";

export type StartupRunEndedReason =
  | "progress_reached"
  | "play_failed"
  | "handoff_to_recovery"
  | "aborted_by_supersession"
  | "aborted_other";

export type StartupAbortCause = `aborted_by_pause_reason:${string}` | "unknown_abort";

export type StartupSuppressedReason = "priming_required" | "already_active_run";

export interface VideoSyncDebugState {
  phase: PremierePhase;
  playerTime: number;
  targetTime: number;
  drift: number;
  isDriftLoopActive: boolean;
  serverOffsetMs: number;
  lastResyncAt: number | null;
  channelStatus: string;
  readyState?: number;
  buffering?: boolean;
  readinessStage?: string;
  recoveryState?: HlsRecoveryState;
  recoveryAttemptsWindow?: string;
  lastErrorClass?: HlsRecoveryErrorClass | null;
  playbackStartState?: PlaybackStartState;
  autoplayBlocked?: boolean;
  playIntentActive?: boolean;
  playbackEngine?: HlsPlaybackEngine;
  manifestParsed?: boolean;
  nativeMetadataLoaded?: boolean;
  nativeCanPlayHls?: boolean;
  nativeHlsMimeType?: string | null;
  operationOwner?: "none" | "startup" | "token_refresh" | "recovery";
  reinitLocked?: boolean;
  pendingReinitReason?: "token_refresh" | "recovery" | null;
  requiresPriming?: boolean;
  isPrimed?: boolean;
  primedForMountId?: number | null;
  startupAttemptId?: number;
  gestureTapCount?: number;
  lastGestureAtMs?: number | null;
  lastPlayAttempt?: string | null;
  startupCalledFromGesture?: boolean;
  hlsInstanceId?: number;
  attachCount?: number;
  detachCount?: number;
  srcSetCount?: number;
  loadCalledCount?: number;
  videoElementMountId?: number;
  videoRefAssignedAtMs?: number | null;
  pauseCount?: number;
  lastPauseReason?: string | null;
  overlayTapHandledCount?: number;
  startupRunStartedCount?: number;
  startupRunAbortedCount?: number;
  startupWindowRunId?: number | null;
  startupWindowStartAtMs?: number | null;
  startupWindowEndAtMs?: number | null;
  runEndedReason?: StartupRunEndedReason | null;
  lastAbortCause?: StartupAbortCause | null;
  startupSuppressedReason?: StartupSuppressedReason | null;
  playAttemptRunId?: number | null;
  playAttemptStartAtMs?: number | null;
  doubleStartSuspected?: boolean;
  suppressedThenTappedSuspected?: boolean;
}

export interface VideoSyncPlayerHandle {
  resyncToCanonicalTime: () => Promise<void>;
}
