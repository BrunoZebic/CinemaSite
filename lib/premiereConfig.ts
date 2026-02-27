export type PremiereState = "WAITING" | "LIVE" | "ENDED";

export interface PremiereConfig {
  roomSlug: string;
  title: string;
  startAtIsoUtc: string;
  endAtIsoUtc: string;
  premiereNumber?: number;
  slowModeSeconds: number;
  maxMessageChars: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type RoomConfigSource = {
  title: string;
  premiereNumber?: number;
  slowModeSeconds: number;
  maxMessageChars: number;
  startAtIsoUtc?: string;
  endAtIsoUtc?: string;
  startOffsetMs?: number;
  durationMs?: number;
};

const ROOM_CONFIGS: Record<string, RoomConfigSource> = {
  demo: {
    title: "Premiere #1 - The Quiet Frame",
    premiereNumber: 1,
    slowModeSeconds: 60,
    maxMessageChars: 320,
    startOffsetMs: DAY_MS,
    durationMs: 2 * HOUR_MS,
  },
  alt: {
    title: "Premiere #2 - Twilight Assembly",
    premiereNumber: 2,
    slowModeSeconds: 45,
    maxMessageChars: 320,
    startOffsetMs: 2 * DAY_MS,
    durationMs: 2 * HOUR_MS,
  },
};

export function getPremiereConfig(room: string): PremiereConfig | null {
  const roomSlug = room.trim().toLowerCase();
  const source = ROOM_CONFIGS[roomSlug];
  if (!source) {
    return null;
  }

  let startAtIsoUtc = source.startAtIsoUtc;
  let endAtIsoUtc = source.endAtIsoUtc;

  if (!startAtIsoUtc || !endAtIsoUtc) {
    const startAtMs = Date.now() + (source.startOffsetMs ?? DAY_MS);
    const endAtMs = startAtMs + (source.durationMs ?? 2 * HOUR_MS);
    startAtIsoUtc = new Date(startAtMs).toISOString();
    endAtIsoUtc = new Date(endAtMs).toISOString();
  }

  return {
    roomSlug,
    title: source.title,
    premiereNumber: source.premiereNumber,
    startAtIsoUtc,
    endAtIsoUtc,
    slowModeSeconds: source.slowModeSeconds,
    maxMessageChars: source.maxMessageChars,
  };
}

export function computePremiereState(
  nowMs: number,
  config: PremiereConfig,
): PremiereState {
  const startAtMs = Date.parse(config.startAtIsoUtc);
  const endAtMs = Date.parse(config.endAtIsoUtc);

  if (Number.isNaN(startAtMs) || Number.isNaN(endAtMs)) {
    return "WAITING";
  }

  if (nowMs < startAtMs) {
    return "WAITING";
  }

  if (nowMs < endAtMs) {
    return "LIVE";
  }

  return "ENDED";
}

export function formatPremiereDateTime(isoUtc: string): string {
  const parsed = new Date(isoUtc);
  if (Number.isNaN(parsed.getTime())) {
    return "Invalid time";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}
