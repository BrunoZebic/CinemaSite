import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildFixedDurations,
  buildSegmentWindows,
  buildSubtitlePlaylist,
  parseMediaPlaylistDurations,
  parseWebVtt,
  segmentWebVtt,
} from "@/lib/subtitles/hlsVtt";
import { getStringFlag, parseArgs } from "./args";

const execFileAsync = promisify(execFile);

function parsePositiveNumber(raw: string | null, flagName: string): number | null {
  if (raw === null) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${flagName} must be a positive number.`);
  }

  return value;
}

function findFirstMediaEntry(mediaPlaylistText: string): string | null {
  const lines = mediaPlaylistText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    return line;
  }
  return null;
}

async function detectMpegtsOffsetSec(mediaPlaylistPath: string): Promise<number> {
  const mediaPlaylistText = await readFile(mediaPlaylistPath, "utf8");
  const firstEntry = findFirstMediaEntry(mediaPlaylistText);
  if (!firstEntry) {
    throw new Error("Unable to find the first media segment entry in the playlist.");
  }

  const firstSegmentPath = path.resolve(path.dirname(mediaPlaylistPath), firstEntry);
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=start_time",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    firstSegmentPath,
  ]);

  const offsetSec = Number(stdout.trim());
  if (!Number.isFinite(offsetSec) || offsetSec < 0) {
    throw new Error(
      `Unable to parse ffprobe start_time for the first segment: ${firstSegmentPath}`,
    );
  }

  return offsetSec;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.help || args.flags.h) {
    process.stdout.write(
      [
        "Usage:",
        "  corepack pnpm tsx scripts/hls/segmentSubtitles.ts --input <file.vtt> --output-dir <dir> --media-playlist <index.m3u8>",
        "  corepack pnpm tsx scripts/hls/segmentSubtitles.ts --input <file.vtt> --output-dir <dir> --segment-duration <seconds> [--total-duration <seconds>]",
        "",
        "Options:",
        "  --input             Source WebVTT file",
        "  --output-dir        Output directory for segmented .vtt files and subtitle playlist",
        "  --media-playlist    Existing HLS media playlist used to align subtitle segments to video segment durations",
        "  --segment-duration  Fixed subtitle segment duration in seconds",
        "  --total-duration    Total coverage duration when using --segment-duration (defaults to the last cue end)",
        "  --mpegts-offset     Explicit initial MPEG-TS timestamp offset in seconds (defaults to ffprobe auto-detect from --media-playlist)",
        "  --playlist-name     Output subtitle playlist file name (default: index.m3u8)",
      ].join("\n") + "\n",
    );
    return;
  }

  const inputPath = getStringFlag(args.flags, "input");
  const outputDir = getStringFlag(args.flags, "output-dir");
  const mediaPlaylistPath = getStringFlag(args.flags, "media-playlist");
  const playlistName = getStringFlag(args.flags, "playlist-name") ?? "index.m3u8";
  const mpegtsOffsetSecOverride = parsePositiveNumber(
    getStringFlag(args.flags, "mpegts-offset"),
    "--mpegts-offset",
  );
  const segmentDurationSec = parsePositiveNumber(
    getStringFlag(args.flags, "segment-duration"),
    "--segment-duration",
  );
  const totalDurationSec = parsePositiveNumber(
    getStringFlag(args.flags, "total-duration"),
    "--total-duration",
  );

  if (!inputPath) {
    throw new Error("Missing --input.");
  }
  if (!outputDir) {
    throw new Error("Missing --output-dir.");
  }

  const usingMediaPlaylist = Boolean(mediaPlaylistPath);
  const usingFixedDuration = segmentDurationSec !== null;
  if (usingMediaPlaylist === usingFixedDuration) {
    throw new Error(
      "Provide exactly one of --media-playlist or --segment-duration.",
    );
  }

  const vttText = await readFile(inputPath, "utf8");
  const cues = parseWebVtt(vttText);
  if (!cues.length) {
    throw new Error("The input VTT file did not contain any cues.");
  }

  let durations: number[];
  let mpegtsOffsetSec = mpegtsOffsetSecOverride ?? 0;
  if (mediaPlaylistPath) {
    const mediaPlaylistText = await readFile(mediaPlaylistPath, "utf8");
    durations = parseMediaPlaylistDurations(mediaPlaylistText);
    if (mpegtsOffsetSecOverride === null) {
      mpegtsOffsetSec = await detectMpegtsOffsetSec(mediaPlaylistPath);
    }
  } else {
    const effectiveTotalDurationSec =
      totalDurationSec ?? Math.max(...cues.map((cue) => cue.endSec));
    durations = buildFixedDurations(effectiveTotalDurationSec, segmentDurationSec!);
  }

  const windows = buildSegmentWindows(durations, "sub_", mpegtsOffsetSec);
  const segments = segmentWebVtt(cues, windows);
  const playlistText = buildSubtitlePlaylist(windows);

  await mkdir(outputDir, { recursive: true });
  await Promise.all(
    segments.map((segment) =>
      writeFile(path.join(outputDir, segment.window.fileName), segment.text, "utf8"),
    ),
  );
  await writeFile(path.join(outputDir, playlistName), playlistText, "utf8");

  const totalDurationFromWindows = durations.reduce(
    (sum, durationSec) => sum + durationSec,
    0,
  );

  process.stdout.write(
    [
      `Wrote ${segments.length} subtitle segment file(s) to ${outputDir}.`,
      `Playlist: ${path.join(outputDir, playlistName)}`,
      `Duration coverage: ${totalDurationFromWindows.toFixed(3)}s`,
      `MPEG-TS offset: ${mpegtsOffsetSec.toFixed(6)}s`,
    ].join("\n") + "\n",
  );
}

void main().catch((error: unknown) => {
  const message =
    error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
