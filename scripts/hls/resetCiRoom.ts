import { pathToFileURL } from "node:url";
import { getStringFlag, parseArgs } from "./args";
import { resetCiRoomStart } from "./ciRoomHelper";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
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
  const args = parseArgs(process.argv.slice(2));
  const room =
    getStringFlag(args.flags, "room") ?? process.env.HLS_TEST_ROOM?.trim() ?? "";

  if (!room) {
    throw new Error("Missing --room or HLS_TEST_ROOM.");
  }

  const normalizedRoom = room.toLowerCase();
  const startOffsetSec = getStartOffsetSec(args.flags);
  const result = await resetCiRoomStart(normalizedRoom, startOffsetSec);

  process.stdout.write(
    `Reset CI room "${result.roomSlug}" to premiere_start_unix_ms=${result.premiereStartUnixMs}\n`,
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
