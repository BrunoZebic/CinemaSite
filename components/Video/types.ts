import type { PremierePhase } from "@/lib/premiere/types";

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
}

export interface VideoSyncPlayerHandle {
  resyncToCanonicalTime: () => Promise<void>;
}
