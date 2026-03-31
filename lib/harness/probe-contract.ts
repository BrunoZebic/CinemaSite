import type { PremierePhase } from "../premiere/types";
import type {
  ChatVisualState,
  PhaseTransitionKind,
  PhaseVisualState,
  ScreenVisualState,
} from "../premiere/presentation";

// Re-export so consumers import from one place
export type { PremierePhase, ChatVisualState, PhaseTransitionKind, PhaseVisualState, ScreenVisualState };

export type PhaseProbeState = {
  playbackStartState?: string;
  isPrimed?: boolean;
};

export type PhaseUiSnapshot = {
  phase: PremierePhase | null;
  countdownLabel: string | null;
  shellPhase: PremierePhase | null;
  phaseVisualState: PhaseVisualState | null;
  transitionKind: PhaseTransitionKind | null;
  playerPhaseVisualState: PhaseVisualState | null;
  playerTransitionKind: PhaseTransitionKind | null;
  chatOpen: string | null;
  chatPhase: string | null;
  chatVisualState: ChatVisualState | null;
  screenVisualState: ScreenVisualState | null;
  playerFullscreen: string | null;
  waitingLobbyVisible: boolean;
  silenceBlackoutVisible: boolean;
  gestureVisible: boolean;
  recoveryRetryVisible: boolean;
  subtitleToggleVisible: boolean;
  posterVisible: boolean;
  staticTreatmentVisible: boolean;
  footerDisplayState: string | null;
  footerText: string;
  composerDisabled: boolean;
  inviteVisible: boolean;
  identityVisible: boolean;
  probe: PhaseProbeState | null;
};
