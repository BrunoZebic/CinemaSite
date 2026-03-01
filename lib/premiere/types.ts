export type PremierePhase =
  | "WAITING"
  | "LIVE"
  | "SILENCE"
  | "DISCUSSION"
  | "CLOSED";

export type VideoProvider = "vimeo" | "hls" | "none";

export interface ScreeningConfig {
  roomSlug: string;
  title: string;
  premiereNumber?: number;
  premiereStartUnixMs: number;
  filmDurationSec: number;
  silenceDurationSec: number;
  discussionDurationMin: number;
  slowModeSeconds: number;
  maxMessageChars: number;
  videoProvider: VideoProvider;
  videoAssetId: string;
  videoManifestPath?: string | null;
  videoManifestUrl?: string | null;
  inviteCodeHash?: string | null;
  hostPassphraseHash?: string | null;
}

export interface RoomBootstrap {
  room: string;
  serverNowUnixMs: number;
  screening: ScreeningConfig | null;
  phase: PremierePhase;
  chatOpen: boolean;
  hasAccess: boolean;
  isHost: boolean;
  finalManifestUrl: string | null;
  tokenExpiresAtUnixMs: number | null;
  requiresPriming: boolean;
  playbackConfigError: string | null;
  rehearsalScrubEnabled: boolean;
}
