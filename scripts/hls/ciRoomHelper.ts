import { createClient } from "@supabase/supabase-js";
import { loadLocalEnv } from "./env";

loadLocalEnv();

type ScreeningRow = {
  room_slug: string;
  premiere_start_unix_ms: number;
  film_duration_sec: number;
  silence_duration_sec: number;
  discussion_duration_min: number;
  poster_image_url: string | null;
};

type SupabaseResult<TData> = {
  data: TData | null;
  error: { message: string } | null;
};

type SupabaseMutationResult = {
  error: { message: string } | null;
};

export type CiRoomConfig = {
  roomSlug: string;
  premiereStartUnixMs: number;
  filmDurationSec: number;
  silenceDurationSec: number;
  discussionDurationMin: number;
  posterImageUrl: string | null;
  supportsPosterField: boolean;
};

const TRANSIENT_RETRY_DELAYS_MS = [300, 1_000];

function normalizeRoom(room: string): string {
  return room.trim().toLowerCase();
}

function isTransientSupabaseFailure(message: string): boolean {
  return /fetch failed|network request failed|etimedout|econnreset|econnrefused|socket|terminated/i.test(
    message,
  );
}

function errorMessageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTransientRetries<T>(
  action: () => PromiseLike<T>,
  getErrorMessage: (result: T) => string | null,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await action();
      const message = getErrorMessage(result);
      if (
        !message ||
        !isTransientSupabaseFailure(message) ||
        attempt >= TRANSIENT_RETRY_DELAYS_MS.length
      ) {
        return result;
      }
    } catch (error) {
      if (
        !isTransientSupabaseFailure(errorMessageFromUnknown(error)) ||
        attempt >= TRANSIENT_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
    }

    await wait(TRANSIENT_RETRY_DELAYS_MS[attempt]);
  }
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

async function readActiveRoomRow(
  room: string,
): Promise<{ row: ScreeningRow; supportsPosterField: boolean }> {
  const client = createSupabaseAdminClient();
  const normalizedRoom = normalizeRoom(room);
  const { data, error } = await withTransientRetries<SupabaseResult<ScreeningRow>>(
    () =>
      client
        .from("screenings")
        .select(
          "room_slug,premiere_start_unix_ms,film_duration_sec,silence_duration_sec,discussion_duration_min,poster_image_url",
        )
        .eq("room_slug", normalizedRoom)
        .eq("is_active", true)
        .limit(1)
        .maybeSingle<ScreeningRow>(),
    (result) => result.error?.message ?? null,
  );

  if (error) {
    if (/poster_image_url/i.test(error.message)) {
      const legacyResult = await withTransientRetries<
        SupabaseResult<Omit<ScreeningRow, "poster_image_url">>
      >(
        () =>
          client
            .from("screenings")
            .select(
              "room_slug,premiere_start_unix_ms,film_duration_sec,silence_duration_sec,discussion_duration_min",
            )
            .eq("room_slug", normalizedRoom)
            .eq("is_active", true)
            .limit(1)
            .maybeSingle<Omit<ScreeningRow, "poster_image_url">>(),
        (result) => result.error?.message ?? null,
      );

      if (legacyResult.error) {
        throw new Error(
          `Failed to query CI room "${normalizedRoom}": ${legacyResult.error.message}`,
        );
      }

      if (!legacyResult.data) {
        throw new Error(`No active screening found for CI room "${normalizedRoom}".`);
      }

      return {
        row: {
          ...legacyResult.data,
          poster_image_url: null,
        },
        supportsPosterField: false,
      };
    }

    throw new Error(`Failed to query CI room "${normalizedRoom}": ${error.message}`);
  }

  if (!data) {
    throw new Error(`No active screening found for CI room "${normalizedRoom}".`);
  }

  return {
    row: data,
    supportsPosterField: true,
  };
}

export async function getCiRoomConfig(room: string): Promise<CiRoomConfig> {
  const { row: data, supportsPosterField } = await readActiveRoomRow(room);
  return {
    roomSlug: data.room_slug,
    premiereStartUnixMs: data.premiere_start_unix_ms,
    filmDurationSec: data.film_duration_sec,
    silenceDurationSec: data.silence_duration_sec,
    discussionDurationMin: data.discussion_duration_min,
    posterImageUrl: data.poster_image_url ?? null,
    supportsPosterField,
  };
}

export async function setCiRoomPosterImage(
  room: string,
  posterImageUrl: string | null,
): Promise<{
  roomSlug: string;
  posterImageUrl: string | null;
  supportsPosterField: boolean;
}> {
  const client = createSupabaseAdminClient();
  const config = await getCiRoomConfig(room);
  if (!config.supportsPosterField) {
    return {
      roomSlug: config.roomSlug,
      posterImageUrl: null,
      supportsPosterField: false,
    };
  }

  const normalizedPosterImageUrl =
    typeof posterImageUrl === "string" && posterImageUrl.trim().length > 0
      ? posterImageUrl.trim()
      : null;

  const { error } = await withTransientRetries<SupabaseMutationResult>(
    () =>
      client
        .from("screenings")
        .update({
          poster_image_url: normalizedPosterImageUrl,
        })
        .eq("room_slug", config.roomSlug)
        .eq("is_active", true),
    (result) => result.error?.message ?? null,
  );

  if (error) {
    throw new Error(
      `Failed to update poster for CI room "${config.roomSlug}": ${error.message}`,
    );
  }

  return {
    roomSlug: config.roomSlug,
    posterImageUrl: normalizedPosterImageUrl,
    supportsPosterField: true,
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

  const { error } = await withTransientRetries<SupabaseMutationResult>(
    () =>
      client
        .from("screenings")
        .update({
          premiere_start_unix_ms: premiereStartUnixMs,
        })
        .eq("room_slug", config.roomSlug)
        .eq("is_active", true),
    (result) => result.error?.message ?? null,
  );

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
