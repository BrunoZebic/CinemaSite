import type { PremierePhase, ScreeningConfig } from "@/lib/premiere/types";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

export function computePremierePhase(
  nowUnixMs: number,
  config: ScreeningConfig,
): PremierePhase {
  const liveStart = config.premiereStartUnixMs;
  const silenceStart = liveStart + config.filmDurationSec * SECOND_MS;
  const discussionStart = silenceStart + config.silenceDurationSec * SECOND_MS;
  const closedStart = discussionStart + config.discussionDurationMin * MINUTE_MS;

  if (nowUnixMs < liveStart) {
    return "WAITING";
  }
  if (nowUnixMs < silenceStart) {
    return "LIVE";
  }
  if (nowUnixMs < discussionStart) {
    return "SILENCE";
  }
  if (nowUnixMs < closedStart) {
    return "DISCUSSION";
  }
  return "CLOSED";
}

export function isChatOpenForPhase(phase: PremierePhase): boolean {
  return phase === "LIVE" || phase === "DISCUSSION";
}

export function getPhaseEndsAtUnixMs(
  phase: PremierePhase,
  config: ScreeningConfig,
): number | null {
  const liveStart = config.premiereStartUnixMs;
  const silenceStart = liveStart + config.filmDurationSec * SECOND_MS;
  const discussionStart = silenceStart + config.silenceDurationSec * SECOND_MS;
  const closedStart = discussionStart + config.discussionDurationMin * MINUTE_MS;

  if (phase === "WAITING") {
    return liveStart;
  }
  if (phase === "LIVE") {
    return silenceStart;
  }
  if (phase === "SILENCE") {
    return discussionStart;
  }
  if (phase === "DISCUSSION") {
    return closedStart;
  }
  return null;
}

export function clampPlaybackTargetSec(
  targetSec: number,
  filmDurationSec: number,
): number {
  return Math.max(0, Math.min(targetSec, filmDurationSec));
}
