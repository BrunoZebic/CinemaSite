import type { PremierePhase } from "@/lib/premiere/types";

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
  operationOwner?: "none" | "startup" | "token_refresh" | "recovery";
  reinitLocked?: boolean;
  pendingReinitReason?: "token_refresh" | "recovery" | null;
}

export interface VideoSyncPlayerHandle {
  resyncToCanonicalTime: () => Promise<void>;
}
