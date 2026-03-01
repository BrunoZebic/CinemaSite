import { createHash } from "crypto";
import { getFallbackScreening } from "@/lib/premiereConfig";
import { computePremierePhase, isChatOpenForPhase } from "@/lib/premiere/phase";
import type { RoomBootstrap, ScreeningConfig } from "@/lib/premiere/types";
import {
  hasValidAccessCookie,
  getAccessCookieName,
  getHostCookieName,
} from "@/lib/server/session";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";
import {
  createSignedBunnyManifestUrl,
  resolveManifestPath,
} from "@/lib/video/bunnyToken";

type ScreeningRow = {
  room_slug?: string;
  title?: string;
  premiere_number?: number | null;
  premiere_start_unix_ms?: number;
  film_duration_sec?: number;
  silence_duration_sec?: number | null;
  discussion_duration_min?: number | null;
  slow_mode_seconds?: number | null;
  max_message_chars?: number | null;
  video_provider?: string | null;
  video_asset_id?: string | null;
  video_manifest_path?: string | null;
  video_manifest_url?: string | null;
  invite_code_hash?: string | null;
  host_passphrase_hash?: string | null;
  is_active?: boolean | null;
};

function mapScreening(row: ScreeningRow): ScreeningConfig {
  const roomSlug = typeof row.room_slug === "string" ? row.room_slug : "";
  const title = typeof row.title === "string" ? row.title : "Untitled Screening";
  const premiereStartUnixMs =
    typeof row.premiere_start_unix_ms === "number"
      ? row.premiere_start_unix_ms
      : Date.now();
  const filmDurationSec =
    typeof row.film_duration_sec === "number" ? row.film_duration_sec : 1200;

  return {
    roomSlug,
    title,
    premiereNumber: row.premiere_number ?? undefined,
    premiereStartUnixMs,
    filmDurationSec,
    silenceDurationSec: row.silence_duration_sec ?? 20,
    discussionDurationMin: row.discussion_duration_min ?? 45,
    slowModeSeconds: row.slow_mode_seconds ?? 60,
    maxMessageChars: row.max_message_chars ?? 320,
    videoProvider:
      row.video_provider === "vimeo" || row.video_provider === "hls"
        ? row.video_provider
        : "none",
    videoAssetId: row.video_asset_id ?? "",
    videoManifestPath: row.video_manifest_path ?? null,
    videoManifestUrl: row.video_manifest_url ?? null,
    inviteCodeHash: row.invite_code_hash,
    hostPassphraseHash: row.host_passphrase_hash,
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function getScreeningConfig(
  room: string,
): Promise<ScreeningConfig | null> {
  const normalizedRoom = room.trim().toLowerCase();
  const admin = getSupabaseAdminClient();

  if (!admin) {
    return getFallbackScreening(normalizedRoom);
  }

  const { data, error } = await admin
    .from("screenings")
    .select("*")
    .eq("room_slug", normalizedRoom)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle<ScreeningRow>();

  if (error || !data) {
    return getFallbackScreening(normalizedRoom);
  }

  return mapScreening(data);
}

export function screeningRequiresInvite(
  screening: ScreeningConfig | null,
): boolean {
  return Boolean(screening?.inviteCodeHash);
}

export function screeningHasHostPassphrase(
  screening: ScreeningConfig | null,
): boolean {
  return Boolean(screening?.hostPassphraseHash);
}

function getRehearsalScrubEnabled(): boolean {
  return process.env.REHEARSAL_SCRUB_ENABLED === "true";
}

function getBunnyTokenKey(): string | null {
  const key = process.env.BUNNY_TOKEN_AUTH_KEY;
  if (!key) {
    return null;
  }
  return key.trim() || null;
}

function getBunnyCdnBaseUrl(): string | null {
  const baseUrl = process.env.BUNNY_CDN_BASE_URL;
  if (!baseUrl) {
    return null;
  }
  return baseUrl.trim() || null;
}

function getBunnyTokenExpirySeconds(filmDurationSec: number): number {
  const defaultSeconds = filmDurationSec + 45 * 60;
  const configured = Number(process.env.BUNNY_TOKEN_EXPIRY_SEC ?? "");
  if (!Number.isFinite(configured) || configured <= 0) {
    return defaultSeconds;
  }
  return Math.max(defaultSeconds, Math.floor(configured));
}

function isAdvancedBunnyTokenMode(): boolean {
  const mode = (process.env.BUNNY_TOKEN_AUTH_MODE ?? "advanced")
    .trim()
    .toLowerCase();
  return mode === "advanced";
}

function sanitizeScreeningForClient(screening: ScreeningConfig): ScreeningConfig {
  return {
    ...screening,
    videoManifestPath: null,
    videoManifestUrl: null,
    videoAssetId: screening.videoProvider === "vimeo" ? screening.videoAssetId : "",
  };
}

export async function buildRoomBootstrap(
  room: string,
  cookieValues: Record<string, string | undefined>,
): Promise<RoomBootstrap> {
  const normalizedRoom = room.trim().toLowerCase();
  const screening = await getScreeningConfig(normalizedRoom);
  const serverNowUnixMs = Date.now();
  const rehearsalScrubEnabled = getRehearsalScrubEnabled();

  if (!screening) {
    return {
      room: normalizedRoom,
      serverNowUnixMs,
      screening: null,
      phase: "WAITING",
      chatOpen: false,
      hasAccess: false,
      isHost: false,
      finalManifestUrl: null,
      tokenExpiresAtUnixMs: null,
      requiresPriming: false,
      playbackConfigError: null,
      rehearsalScrubEnabled,
    };
  }

  const accessCookie = cookieValues[getAccessCookieName(normalizedRoom)];
  const hostCookie = cookieValues[getHostCookieName(normalizedRoom)];

  const hasAccess = screeningRequiresInvite(screening)
    ? hasValidAccessCookie(accessCookie, normalizedRoom)
    : true;
  const isHost = screeningHasHostPassphrase(screening)
    ? hasValidAccessCookie(hostCookie, normalizedRoom)
    : false;

  const phase = computePremierePhase(serverNowUnixMs, screening);
  const chatOpen = hasAccess && isChatOpenForPhase(phase);
  const requiresPriming = screening.videoProvider === "hls";
  const clientScreening = sanitizeScreeningForClient(screening);
  let finalManifestUrl: string | null = null;
  let tokenExpiresAtUnixMs: number | null = null;
  let playbackConfigError: string | null = null;

  if (requiresPriming && hasAccess) {
    const pathResolution = resolveManifestPath({
      manifestPath: screening.videoManifestPath,
      legacyManifestUrl: screening.videoManifestUrl,
      cdnBaseUrl: getBunnyCdnBaseUrl(),
    });

    if (!pathResolution.ok) {
      playbackConfigError = pathResolution.error;
    } else {
      const cdnBaseUrl = getBunnyCdnBaseUrl();
      const tokenKey = getBunnyTokenKey();
      if (!isAdvancedBunnyTokenMode()) {
        playbackConfigError = "BUNNY_TOKEN_AUTH_MODE must be set to 'advanced'.";
      } else if (!cdnBaseUrl || !tokenKey) {
        playbackConfigError = "HLS token signing is not configured.";
      } else {
        try {
          const nowUnixMs = Date.now();
          const expiresInSeconds = getBunnyTokenExpirySeconds(
            screening.filmDurationSec,
          );
          finalManifestUrl = createSignedBunnyManifestUrl({
            cdnBaseUrl,
            manifestPath: pathResolution.manifestPath,
            tokenKey,
            expiresInSeconds,
            nowUnixMs,
          });
          tokenExpiresAtUnixMs = nowUnixMs + expiresInSeconds * 1000;
        } catch {
          playbackConfigError = "Unable to sign HLS manifest URL.";
        }
      }
    }
  }

  return {
    room: normalizedRoom,
    serverNowUnixMs,
    screening: clientScreening,
    phase,
    chatOpen,
    hasAccess,
    isHost,
    finalManifestUrl,
    tokenExpiresAtUnixMs,
    requiresPriming,
    playbackConfigError,
    rehearsalScrubEnabled,
  };
}
