import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { getStringFlag, parseArgs } from "./args";
import { loadLocalEnv } from "./env";
import {
  createSignedBunnyManifestUrl,
  resolveManifestPath,
} from "../../lib/video/bunnyToken";

type ScreeningRow = {
  room_slug: string;
  is_active: boolean;
  film_duration_sec: number | null;
  video_provider: string | null;
  video_manifest_path: string | null;
  video_manifest_url?: string | null;
};

export type SignedUrlOptions = {
  room: string;
};

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function getConfiguredExpirySeconds(filmDurationSec: number): number {
  const defaultSeconds = filmDurationSec + 45 * 60;
  const configured = Number(process.env.BUNNY_TOKEN_EXPIRY_SEC ?? "");
  if (!Number.isFinite(configured) || configured <= 0) {
    return defaultSeconds;
  }
  return Math.max(defaultSeconds, Math.floor(configured));
}

export async function getSignedUrlForRoom(
  options: SignedUrlOptions,
): Promise<string> {
  const room = options.room.trim().toLowerCase();
  if (!room) {
    throw new Error("Room is required.");
  }

  const supabaseUrl = getRequiredEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRole = getRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const cdnBaseUrl = getRequiredEnv("BUNNY_CDN_BASE_URL");
  const tokenKey = getRequiredEnv("BUNNY_TOKEN_AUTH_KEY");
  const tokenMode = (process.env.BUNNY_TOKEN_AUTH_MODE ?? "advanced")
    .trim()
    .toLowerCase();

  if (tokenMode !== "advanced") {
    throw new Error("BUNNY_TOKEN_AUTH_MODE must be 'advanced'.");
  }

  const supabase = createClient(supabaseUrl, serviceRole, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  let data: ScreeningRow | null = null;
  let error: Error | null = null;

  const withLegacy = await supabase
    .from("screenings")
    .select(
      "room_slug,is_active,film_duration_sec,video_provider,video_manifest_path,video_manifest_url",
    )
    .eq("room_slug", room)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle<ScreeningRow>();

  if (withLegacy.error?.message.includes("video_manifest_url")) {
    const fallback = await supabase
      .from("screenings")
      .select("room_slug,is_active,film_duration_sec,video_provider,video_manifest_path")
      .eq("room_slug", room)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle<ScreeningRow>();
    data = fallback.data ?? null;
    error = fallback.error
      ? new Error(fallback.error.message)
      : null;
  } else {
    data = withLegacy.data ?? null;
    error = withLegacy.error ? new Error(withLegacy.error.message) : null;
  }

  if (error) {
    throw new Error(`Failed to query screening: ${error.message}`);
  }

  if (!data) {
    throw new Error(`No active screening found for room '${room}'.`);
  }

  if (data.video_provider !== "hls") {
    throw new Error(`Room '${room}' is not configured for HLS.`);
  }

  const pathResolution = resolveManifestPath({
    manifestPath: data.video_manifest_path,
    legacyManifestUrl: data.video_manifest_url,
    cdnBaseUrl,
  });

  if (!pathResolution.ok) {
    throw new Error(pathResolution.error);
  }

  const filmDurationSec =
    typeof data.film_duration_sec === "number" ? data.film_duration_sec : 1200;

  const expiresInSeconds = getConfiguredExpirySeconds(filmDurationSec);

  return createSignedBunnyManifestUrl({
    cdnBaseUrl,
    manifestPath: pathResolution.manifestPath,
    tokenKey,
    expiresInSeconds,
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const room =
    getStringFlag(args.flags, "room") ??
    process.env.HLS_TEST_ROOM?.trim() ??
    "demo";

  const signedUrl = await getSignedUrlForRoom({
    room,
  });
  process.stdout.write(`${signedUrl}\n`);
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
