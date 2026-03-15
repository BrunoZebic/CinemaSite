export type WebVttCue = {
  identifier: string | null;
  startSec: number;
  endSec: number;
  settings: string;
  payload: string[];
};

export type SubtitleSegmentWindow = {
  index: number;
  startSec: number;
  durationSec: number;
  fileName: string;
  mpegtsStartSec: number;
};

export type SubtitleSegment = {
  window: SubtitleSegmentWindow;
  cues: WebVttCue[];
  text: string;
};

const TIMING_LINE_PATTERN =
  /^(\d{2}:\d{2}(?::\d{2})?\.\d{3})\s+-->\s+(\d{2}:\d{2}(?::\d{2})?\.\d{3})((?:\s+.*)?)$/;

function normalizeText(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseTimestamp(input: string): number {
  const parts = input.split(":");
  const secondsPart = parts.pop();
  if (!secondsPart || parts.length < 1 || parts.length > 2) {
    throw new Error(`Unsupported WebVTT timestamp: ${input}`);
  }

  const [secondsText, millisText] = secondsPart.split(".", 2);
  if (millisText === undefined) {
    throw new Error(`Missing milliseconds in WebVTT timestamp: ${input}`);
  }

  const seconds = Number(secondsText);
  const millis = Number(millisText);
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;

  if ([hours, minutes, seconds, millis].some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid numeric value in WebVTT timestamp: ${input}`);
  }

  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function formatTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const totalMillis = Math.round(clamped * 1000);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0",
  )}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export function parseWebVtt(input: string): WebVttCue[] {
  const text = normalizeText(input);
  const lines = text.split("\n");
  if (lines.length === 0 || !lines[0].startsWith("WEBVTT")) {
    throw new Error("Input does not start with a WEBVTT header.");
  }

  const cues: WebVttCue[] = [];
  let currentBlock: string[] = [];

  function flushBlock(): void {
    if (!currentBlock.length) {
      return;
    }

    const block = currentBlock;
    currentBlock = [];

    if (block[0].startsWith("NOTE") || block[0] === "STYLE" || block[0] === "REGION") {
      return;
    }

    const timingLineIndex = block.findIndex((line) => line.includes("-->"));
    if (timingLineIndex === -1) {
      return;
    }

    const timingLine = block[timingLineIndex];
    const match = timingLine.match(TIMING_LINE_PATTERN);
    if (!match) {
      throw new Error(`Invalid cue timing line: ${timingLine}`);
    }

    const startText = match[1];
    const endText = match[2];
    const settingsText = match[3];

    const identifier =
      timingLineIndex > 0 ? block.slice(0, timingLineIndex).join("\n") : null;
    const payload = block.slice(timingLineIndex + 1);
    if (!payload.length) {
      return;
    }

    cues.push({
      identifier,
      startSec: parseTimestamp(startText),
      endSec: parseTimestamp(endText),
      settings: settingsText?.trim() ?? "",
      payload,
    });
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      flushBlock();
      continue;
    }
    currentBlock.push(line);
  }
  flushBlock();

  return cues;
}

export function parseMediaPlaylistDurations(input: string): number[] {
  const text = normalizeText(input);
  const durations = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => {
      const raw = line.slice("#EXTINF:".length).split(",", 2)[0]?.trim() ?? "";
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid EXTINF duration: ${line}`);
      }
      return value;
    });

  if (!durations.length) {
    throw new Error("Media playlist did not contain any EXTINF durations.");
  }

  return durations;
}

export function buildSegmentWindows(
  durations: number[],
  filePrefix: string = "sub_",
  mpegtsOffsetSec: number = 0,
): SubtitleSegmentWindow[] {
  let runningStartSec = 0;
  return durations.map((durationSec, index) => {
    const window: SubtitleSegmentWindow = {
      index,
      startSec: runningStartSec,
      durationSec,
      fileName: `${filePrefix}${String(index).padStart(5, "0")}.vtt`,
      mpegtsStartSec: runningStartSec + mpegtsOffsetSec,
    };
    runningStartSec += durationSec;
    return window;
  });
}

function cueOverlapsWindow(
  cue: WebVttCue,
  windowStartSec: number,
  windowEndSec: number,
): boolean {
  return cue.endSec > windowStartSec && cue.startSec < windowEndSec;
}

function toSegmentCue(
  cue: WebVttCue,
  windowStartSec: number,
  windowEndSec: number,
): WebVttCue | null {
  const clippedStartSec = Math.max(cue.startSec, windowStartSec);
  const clippedEndSec = Math.min(cue.endSec, windowEndSec);
  if (clippedEndSec <= clippedStartSec) {
    return null;
  }

  return {
    identifier: cue.identifier,
    startSec: clippedStartSec - windowStartSec,
    endSec: clippedEndSec - windowStartSec,
    settings: cue.settings,
    payload: cue.payload,
  };
}

export function formatSegmentVtt(
  window: SubtitleSegmentWindow,
  cues: WebVttCue[],
): string {
  const lines: string[] = [
    "WEBVTT",
    `X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:${Math.round(
      window.mpegtsStartSec * 90_000,
    )}`,
    "",
  ];

  cues.forEach((cue, index) => {
    if (cue.identifier) {
      lines.push(cue.identifier);
    }
    lines.push(
      `${formatTimestamp(cue.startSec)} --> ${formatTimestamp(cue.endSec)}${
        cue.settings ? ` ${cue.settings}` : ""
      }`,
    );
    lines.push(...cue.payload);
    if (index < cues.length - 1) {
      lines.push("");
    }
  });

  lines.push("");
  return lines.join("\n");
}

export function segmentWebVtt(
  cues: WebVttCue[],
  windows: SubtitleSegmentWindow[],
): SubtitleSegment[] {
  return windows.map((window) => {
    const windowEndSec = window.startSec + window.durationSec;
    const segmentCues = cues
      .filter((cue) => cueOverlapsWindow(cue, window.startSec, windowEndSec))
      .map((cue) => toSegmentCue(cue, window.startSec, windowEndSec))
      .filter((cue): cue is WebVttCue => cue !== null);

    return {
      window,
      cues: segmentCues,
      text: formatSegmentVtt(window, segmentCues),
    };
  });
}

export function buildSubtitlePlaylist(windows: SubtitleSegmentWindow[]): string {
  if (!windows.length) {
    throw new Error("Cannot build a subtitle playlist without any segment windows.");
  }

  const targetDuration = Math.max(
    1,
    Math.ceil(Math.max(...windows.map((window) => window.durationSec))),
  );

  const lines: string[] = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];

  windows.forEach((window) => {
    lines.push(`#EXTINF:${window.durationSec.toFixed(3)},`);
    lines.push(window.fileName);
  });

  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

export function buildFixedDurations(
  totalDurationSec: number,
  segmentDurationSec: number,
): number[] {
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) {
    throw new Error("Total duration must be a positive number of seconds.");
  }
  if (!Number.isFinite(segmentDurationSec) || segmentDurationSec <= 0) {
    throw new Error("Segment duration must be a positive number of seconds.");
  }

  const durations: number[] = [];
  let remainingSec = totalDurationSec;

  while (remainingSec > 0) {
    const nextDurationSec = Math.min(segmentDurationSec, remainingSec);
    durations.push(nextDurationSec);
    remainingSec -= nextDurationSec;
  }

  return durations;
}
