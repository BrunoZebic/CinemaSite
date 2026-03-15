import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { getStringFlag, parseArgs } from "./args";
import { loadLocalEnv } from "./env";

type ScreeningRow = {
  room_slug: string;
};

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
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

function getStartOffsetSec(flags: Record<string, string | boolean>): number {
  const rawValue = getStringFlag(flags, "start-offset-sec");
  if (rawValue === null) {
    return -90;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error("Invalid --start-offset-sec value.");
  }

  return parsed;
}

async function main(): Promise<void> {
  loadLocalEnv();

  const args = parseArgs(process.argv.slice(2));
  const room =
    getStringFlag(args.flags, "room") ?? process.env.HLS_TEST_ROOM?.trim() ?? "";

  if (!room) {
    throw new Error("Missing --room or HLS_TEST_ROOM.");
  }

  const normalizedRoom = room.toLowerCase();
  const startOffsetSec = getStartOffsetSec(args.flags);
  const premiereStartUnixMs = Date.now() + startOffsetSec * 1000;
  const client = createClient(getSupabaseUrl(), getServiceRoleKey(), {
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

  const { data, error } = await client
    .from("screenings")
    .select("room_slug")
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

  const { error: updateError } = await client
    .from("screenings")
    .update({
      premiere_start_unix_ms: premiereStartUnixMs,
    })
    .eq("room_slug", normalizedRoom)
    .eq("is_active", true);

  if (updateError) {
    throw new Error(
      `Failed to reset CI room "${normalizedRoom}": ${updateError.message}`,
    );
  }

  process.stdout.write(
    `Reset CI room "${normalizedRoom}" to premiere_start_unix_ms=${premiereStartUnixMs}\n`,
  );
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
