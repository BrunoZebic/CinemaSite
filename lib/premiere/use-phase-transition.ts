"use client";

import { useEffect, useRef, useState } from "react";
import {
  transitionKindForPhases,
  type PhaseTransitionKind,
  type PhaseVisualState,
} from "@/lib/premiere/presentation";
import type { PremierePhase } from "@/lib/premiere/types";

type UsePhaseTransitionResult = {
  transitionKind: PhaseTransitionKind;
  phaseVisualState: PhaseVisualState;
};

export function usePhaseTransition(
  phase: PremierePhase,
  durationMs: number,
): UsePhaseTransitionResult {
  const previousPhaseRef = useRef<PremierePhase>(phase);
  const [transitionState, setTransitionState] = useState<UsePhaseTransitionResult>({
    transitionKind: "none",
    phaseVisualState: "steady",
  });

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    if (previousPhase === phase) {
      return;
    }

    previousPhaseRef.current = phase;
    const nextTransitionKind = transitionKindForPhases(previousPhase, phase);
    const publishTimer = window.setTimeout(() => {
      setTransitionState({
        transitionKind: nextTransitionKind,
        phaseVisualState: nextTransitionKind === "none" ? "steady" : "transitioning",
      });
    }, 0);

    if (nextTransitionKind === "none") {
      return () => window.clearTimeout(publishTimer);
    }

    const clearTimer = window.setTimeout(() => {
      setTransitionState({
        transitionKind: "none",
        phaseVisualState: "steady",
      });
    }, durationMs);

    return () => {
      window.clearTimeout(publishTimer);
      window.clearTimeout(clearTimer);
    };
  }, [durationMs, phase]);

  return transitionState;
}
