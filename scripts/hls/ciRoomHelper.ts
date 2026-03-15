import { createClient } from "@supabase/supabase-js";
import { loadLocalEnv } from "./env";

loadLocalEnv();

type ScreeningRow = {
  room_slug: string;
  premiere_start_unix_ms: number;
  film_duration_sec: number;
  silence_duration_sec: number;
  discussion_duration_min: number;
};

export type CiRoomConfig = {
  roomSlug: string;
  premiereStartUnixMs: number;
  filmDurationSec: number;
  silenceDurationSec: number;
  discussionDurationMin: number;
};

function normalizeRoom(room: string): string {
  return room.trim().toLowerCase();
}

function getSupabaseUrl(): string {
  const url =
    process.env.CI_SUPABASE_URL?.trim() ??
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ??
    "";
  if (!url) {
    throw new Error("Missing CI_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL.");
  }
  return url;
}

function getServiceRoleKey(): string {
  const key =
    process.env.CI_SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    "";
  if (!key) {
    throw new Error(
      "Missing CI_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return key;
}

function createSupabaseAdminClient() {
  return createClient(getSupabaseUrl(), getServiceRoleKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    realtime: {
      params: {
        eventsPerSecond: 8,
      },
    },
  });
}

async function readActiveRoomRow(room: string): Promise<ScreeningRow> {
  const client = createSupabaseAdminClient();
  const normalizedRoom = normalizeRoom(room);
  const { data, error } = await client
    .from("screenings")
    .select(
      "room_slug,premiere_start_unix_ms,film_duration_sec,silence_duration_sec,discussion_duration_min",
    )
    .eq("room_slug", normalizedRoom)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle<ScreeningRow>();

  if (error) {
    throw new Error(`Failed to query CI room "${normalizedRoom}": ${error.message}`);
  }

  if (!data) {
    throw new Error(`No active screening found for CI room "${normalizedRoom}".`);
  }

  return data;
}

export async function getCiRoomConfig(room: string): Promise<CiRoomConfig> {
  const data = await readActiveRoomRow(room);
  return {
    roomSlug: data.room_slug,
    premiereStartUnixMs: data.premiere_start_unix_ms,
    filmDurationSec: data.film_duration_sec,
    silenceDurationSec: data.silence_duration_sec,
    discussionDurationMin: data.discussion_duration_min,
  };
}

export async function resetCiRoomStart(
  room: string,
  startOffsetSec: number,
): Promise<{
  roomSlug: string;
  premiereStartUnixMs: number;
}> {
  if (!Number.isFinite(startOffsetSec)) {
    throw new Error("Invalid start offset; expected a finite number of seconds.");
  }

  const client = createSupabaseAdminClient();
  const config = await getCiRoomConfig(room);
  const premiereStartUnixMs = Date.now() + startOffsetSec * 1000;

  const { error } = await client
    .from("screenings")
    .update({
      premiere_start_unix_ms: premiereStartUnixMs,
    })
    .eq("room_slug", config.roomSlug)
    .eq("is_active", true);

  if (error) {
    throw new Error(
      `Failed to reset CI room "${config.roomSlug}": ${error.message}`,
    );
  }

  return {
    roomSlug: config.roomSlug,
    premiereStartUnixMs,
  };
}
