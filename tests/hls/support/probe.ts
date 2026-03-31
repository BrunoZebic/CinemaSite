import type { Page } from "@playwright/test";
import type { PhaseUiSnapshot, PhaseProbeState, PhaseVisualState, PhaseTransitionKind, ChatVisualState, ScreenVisualState, PremierePhase } from "../../../lib/harness/probe-contract";

export async function readPhaseUiSnapshot(page: Page): Promise<PhaseUiSnapshot> {
  return page.evaluate(() => {
    function isVisible(element: Element | null): boolean {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const styles = window.getComputedStyle(element);
      if (styles.display === "none" || styles.visibility === "hidden") {
        return false;
      }

      return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    }

    const shell = document.querySelector('[data-testid="premiere-shell"]');
    const phaseBadge = document.querySelector('[data-testid="phase-badge"]');
    const countdown = document.querySelector('[data-testid="phase-countdown"]');
    const chatPanel = document.querySelector('[data-testid="chat-panel"]');
    const playerShell = document.querySelector('[data-testid="player-presentation-shell"]');
    const waitingLobby = document.querySelector('[data-testid="waiting-lobby-overlay"]');
    const silenceBlackout = document.querySelector('[data-testid="silence-blackout"]');
    const gestureButton = document.querySelector('[data-testid="gesture-play-cta"]');
    const recoveryRetry = document.querySelector('[data-testid="recovery-retry"]');
    const subtitleToggle = document.querySelector('[data-testid="subtitle-toggle"]');
    const posterImage = document.querySelector('[data-testid="phase-poster-image"]');
    const staticTreatment = document.querySelector('[data-testid="phase-static-treatment"]');
    const footer = document.querySelector('[data-testid="video-status-note"]');
    const composerInput = document.querySelector(
      '[data-testid="chat-composer-input"]',
    ) as HTMLTextAreaElement | null;
    const inviteInput = document.querySelector('[data-testid="invite-code-input"]');
    const identityInput = document.querySelector('[data-testid="identity-nickname-input"]');
    const probe = (
      window as unknown as { __HLS_E2E_PROBE__?: PhaseProbeState }
    ).__HLS_E2E_PROBE__;

    return {
      phase: (phaseBadge?.getAttribute("data-phase") as PremierePhase | null) ?? null,
      countdownLabel: countdown?.getAttribute("data-countdown-label") ?? null,
      shellPhase: (shell?.getAttribute("data-phase") as PremierePhase | null) ?? null,
      phaseVisualState:
        (shell?.getAttribute("data-phase-visual-state") as PhaseVisualState | null) ??
        null,
      transitionKind:
        (shell?.getAttribute("data-transition-kind") as PhaseTransitionKind | null) ??
        null,
      playerPhaseVisualState:
        (playerShell?.getAttribute("data-player-phase-visual-state") as PhaseVisualState | null) ??
        null,
      playerTransitionKind:
        (playerShell?.getAttribute("data-player-transition-kind") as PhaseTransitionKind | null) ??
        null,
      chatOpen: chatPanel?.getAttribute("data-chat-open") ?? null,
      chatPhase: chatPanel?.getAttribute("data-chat-phase") ?? null,
      chatVisualState:
        (chatPanel?.getAttribute("data-chat-visual-state") as ChatVisualState | null) ??
        null,
      screenVisualState:
        (playerShell?.getAttribute("data-screen-visual-state") as ScreenVisualState | null) ??
        null,
      playerFullscreen: playerShell?.getAttribute("data-player-fullscreen") ?? null,
      waitingLobbyVisible: isVisible(waitingLobby),
      silenceBlackoutVisible: isVisible(silenceBlackout),
      gestureVisible: isVisible(gestureButton),
      recoveryRetryVisible: isVisible(recoveryRetry),
      subtitleToggleVisible: isVisible(subtitleToggle),
      posterVisible: isVisible(posterImage),
      staticTreatmentVisible: isVisible(staticTreatment),
      footerDisplayState: footer?.getAttribute("data-footer-display-state") ?? null,
      footerText: footer?.textContent?.trim() ?? "",
      composerDisabled: composerInput?.disabled ?? true,
      inviteVisible: isVisible(inviteInput),
      identityVisible: isVisible(identityInput),
      probe: probe ?? null,
    };
  });
}
