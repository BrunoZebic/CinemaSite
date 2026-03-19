import type { PremierePhase } from "@/lib/premiere/types";

// Intentionally exaggerated on the UI branch so phase-shift animations are easy to verify.
export const RITUAL_PHASE_TRANSITION_DURATION_MS = 5000;

export type PhaseVisualState = "steady" | "transitioning";
export type PhaseTransitionKind =
  | "none"
  | "to-live"
  | "to-silence"
  | "to-discussion"
  | "to-closed";
export type ScreenVisualState =
  | "waiting-static"
  | "live-motion"
  | "silence-black"
  | "discussion-poster"
  | "discussion-static"
  | "closed-poster"
  | "closed-static";
export type ChatVisualState = "dimmed" | "hidden" | "bright" | "muted";

export function badgeClassNameForPhase(phase: PremierePhase): string {
  if (phase === "WAITING") {
    return "state-waiting";
  }

  if (phase === "LIVE") {
    return "state-live";
  }

  if (phase === "DISCUSSION") {
    return "state-discussion";
  }

  return "state-ended";
}

export function transitionKindForPhases(
  previousPhase: PremierePhase,
  nextPhase: PremierePhase,
): PhaseTransitionKind {
  if (previousPhase === nextPhase) {
    return "none";
  }
  if (previousPhase === "WAITING" && nextPhase === "LIVE") {
    return "to-live";
  }
  if (previousPhase === "LIVE" && nextPhase === "SILENCE") {
    return "to-silence";
  }
  if (previousPhase === "SILENCE" && nextPhase === "DISCUSSION") {
    return "to-discussion";
  }
  if (previousPhase === "DISCUSSION" && nextPhase === "CLOSED") {
    return "to-closed";
  }
  return "none";
}

export function chatVisualStateForPhase(phase: PremierePhase): ChatVisualState {
  if (phase === "SILENCE") {
    return "hidden";
  }
  if (phase === "DISCUSSION") {
    return "bright";
  }
  if (phase === "CLOSED") {
    return "muted";
  }
  return "dimmed";
}

export function screenVisualStateForPhase(
  phase: PremierePhase,
  hasPoster: boolean,
): ScreenVisualState {
  if (phase === "LIVE") {
    return "live-motion";
  }
  if (phase === "SILENCE") {
    return "silence-black";
  }
  if (phase === "DISCUSSION") {
    return hasPoster ? "discussion-poster" : "discussion-static";
  }
  if (phase === "CLOSED") {
    return hasPoster ? "closed-poster" : "closed-static";
  }
  return "waiting-static";
}

export function isPlaybackSurfacePhase(phase: PremierePhase): boolean {
  return phase === "WAITING" || phase === "LIVE" || phase === "SILENCE";
}
