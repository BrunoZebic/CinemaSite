const DEFAULT_AUTH_KEYS = ["token", "bcdn_token", "expires", "token_path"];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

export function buildAuthKeySet(
  extraKeys?: Iterable<string> | string | null,
): Set<string> {
  const set = new Set(DEFAULT_AUTH_KEYS.map(normalizeKey));

  if (typeof extraKeys === "string") {
    for (const key of extraKeys.split(",")) {
      const normalized = normalizeKey(key);
      if (normalized) {
        set.add(normalized);
      }
    }
    return set;
  }

  if (extraKeys) {
    for (const key of extraKeys) {
      const normalized = normalizeKey(key);
      if (normalized) {
        set.add(normalized);
      }
    }
  }

  return set;
}

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function stripAuthParams(url: string, authKeys: Set<string>): string {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return url;
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (authKeys.has(normalizeKey(key))) {
      parsed.searchParams.delete(key);
    }
  }

  return parsed.toString();
}

export function redactUrl(url: string, authKeys: Set<string>): string {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return url;
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (authKeys.has(normalizeKey(key))) {
      parsed.searchParams.set(key, "REDACTED");
    }
  }
  return parsed.toString();
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

export function redactText(text: string, authKeys: Set<string>): string {
  return text.replace(URL_PATTERN, (match) => redactUrl(match, authKeys));
}

export function redactUnknown(value: unknown, authKeys: Set<string>): unknown {
  if (typeof value === "string") {
    return redactText(value, authKeys);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactUnknown(entry, authKeys));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactUnknown(entry, authKeys);
    }
    return output;
  }

  return value;
}
