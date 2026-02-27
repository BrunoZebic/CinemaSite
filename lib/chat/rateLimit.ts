const LAST_SENT_PREFIX = "premiere.lastSentAt.";
const DUPLICATE_WINDOW_MS = 60_000;
const DUPLICATE_THRESHOLD = 3;

type DuplicateTracker = {
  normalizedText: string;
  firstTs: number;
  lastTs: number;
  count: number;
};

const duplicateTrackers = new Map<string, DuplicateTracker>();

export type SendValidationErrorReason =
  | "empty"
  | "too_long"
  | "slow_mode"
  | "duplicate";

export type SendValidationResult =
  | {
      ok: true;
      normalizedText: string;
    }
  | {
      ok: false;
      reason: SendValidationErrorReason;
      message: string;
      remainingSeconds?: number;
    };

export interface SendValidationOptions {
  room: string;
  senderSignature: string;
  text: string;
  slowModeSeconds: number;
  maxMessageChars: number;
  nowMs?: number;
}

export interface RegisterSentMessageOptions {
  room: string;
  senderSignature: string;
  normalizedText: string;
  nowMs?: number;
}

function hasWindow() {
  return typeof window !== "undefined";
}

function normalizeMessage(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function readLastSentAt(room: string): number {
  if (!hasWindow()) {
    return 0;
  }

  const raw = window.localStorage.getItem(`${LAST_SENT_PREFIX}${room}`);
  if (!raw) {
    return 0;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function writeLastSentAt(room: string, timestamp: number): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(`${LAST_SENT_PREFIX}${room}`, String(timestamp));
}

export function getRemainingCooldownSeconds(
  room: string,
  slowModeSeconds: number,
  nowMs: number = Date.now(),
): number {
  if (slowModeSeconds <= 0) {
    return 0;
  }

  const lastSentAt = readLastSentAt(room);
  if (!lastSentAt) {
    return 0;
  }

  const elapsedMs = nowMs - lastSentAt;
  const remainingMs = slowModeSeconds * 1000 - elapsedMs;
  if (remainingMs <= 0) {
    return 0;
  }

  return Math.ceil(remainingMs / 1000);
}

export function validateMessageBeforeSend(
  options: SendValidationOptions,
): SendValidationResult {
  const nowMs = options.nowMs ?? Date.now();
  const normalizedText = normalizeMessage(options.text);

  if (!normalizedText) {
    return {
      ok: false,
      reason: "empty",
      message: "Write a message before sending.",
    };
  }

  if (normalizedText.length > options.maxMessageChars) {
    return {
      ok: false,
      reason: "too_long",
      message: `Message too long. Max ${options.maxMessageChars} characters.`,
    };
  }

  const remainingSeconds = getRemainingCooldownSeconds(
    options.room,
    options.slowModeSeconds,
    nowMs,
  );
  if (remainingSeconds > 0) {
    return {
      ok: false,
      reason: "slow_mode",
      message: `Send available in ${remainingSeconds}s.`,
      remainingSeconds,
    };
  }

  const trackerKey = `${options.room}::${options.senderSignature}`;
  const tracker = duplicateTrackers.get(trackerKey);
  if (
    tracker &&
    tracker.normalizedText === normalizedText &&
    nowMs - tracker.firstTs <= DUPLICATE_WINDOW_MS &&
    tracker.count >= DUPLICATE_THRESHOLD - 1
  ) {
    return {
      ok: false,
      reason: "duplicate",
      message: "Repeated message blocked by anti-spam.",
    };
  }

  return {
    ok: true,
    normalizedText,
  };
}

export function registerSentMessage(options: RegisterSentMessageOptions): void {
  const nowMs = options.nowMs ?? Date.now();
  writeLastSentAt(options.room, nowMs);

  const trackerKey = `${options.room}::${options.senderSignature}`;
  const previous = duplicateTrackers.get(trackerKey);

  if (
    previous &&
    previous.normalizedText === options.normalizedText &&
    nowMs - previous.firstTs <= DUPLICATE_WINDOW_MS
  ) {
    duplicateTrackers.set(trackerKey, {
      normalizedText: options.normalizedText,
      firstTs: previous.firstTs,
      lastTs: nowMs,
      count: previous.count + 1,
    });
    return;
  }

  duplicateTrackers.set(trackerKey, {
    normalizedText: options.normalizedText,
    firstTs: nowMs,
    lastTs: nowMs,
    count: 1,
  });
}
