import type { PremierePhase } from "@/lib/premiere/types";

export type HlsRecoveryState = "IDLE" | "RECOVERING" | "DEGRADED";

export type HlsRecoveryErrorClass =
  | "AUTH_SUSPECTED"
  | "NETWORK_OR_PARSE"
  | "MEDIA_STALL";

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
}

export interface VideoSyncPlayerHandle {
  resyncToCanonicalTime: () => Promise<void>;
}
