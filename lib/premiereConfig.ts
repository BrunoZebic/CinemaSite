import type { ScreeningConfig } from "@/lib/premiere/types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type FallbackConfig = {
  title: string;
  premiereNumber?: number;
  startOffsetMs: number;
  filmDurationSec: number;
  silenceDurationSec: number;
  discussionDurationMin: number;
  slowModeSeconds: number;
  maxMessageChars: number;
  videoProvider: "vimeo" | "hls" | "none";
  videoAssetId: string;
};

const FALLBACK_CONFIGS: Record<string, FallbackConfig> = {
  demo: {
    title: "Premiere #1 - The Quiet Frame",
    premiereNumber: 1,
    startOffsetMs: DAY_MS,
    filmDurationSec: 20 * 60,
    silenceDurationSec: 20,
    discussionDurationMin: 45,
    slowModeSeconds: 60,
    maxMessageChars: 320,
    videoProvider: "vimeo",
    videoAssetId: "",
  },
  alt: {
    title: "Premiere #2 - Twilight Assembly",
    premiereNumber: 2,
    startOffsetMs: 2 * DAY_MS,
    filmDurationSec: 20 * 60,
    silenceDurationSec: 20,
    discussionDurationMin: 45,
    slowModeSeconds: 45,
    maxMessageChars: 320,
    videoProvider: "vimeo",
    videoAssetId: "",
  },
};

export function getFallbackScreening(room: string): ScreeningConfig | null {
  const roomSlug = room.trim().toLowerCase();
  const source = FALLBACK_CONFIGS[roomSlug];
  if (!source) {
    return null;
  }

  return {
    roomSlug,
    title: source.title,
    premiereNumber: source.premiereNumber,
    premiereStartUnixMs: Date.now() + source.startOffsetMs,
    filmDurationSec: source.filmDurationSec,
    silenceDurationSec: source.silenceDurationSec,
    discussionDurationMin: source.discussionDurationMin,
    slowModeSeconds: source.slowModeSeconds,
    maxMessageChars: source.maxMessageChars,
    videoProvider: source.videoProvider,
    videoAssetId: source.videoAssetId,
  };
}

export function formatUnixDateTime(unixMs: number): string {
  const parsed = new Date(unixMs);
  if (Number.isNaN(parsed.getTime())) {
    return "Invalid time";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}
