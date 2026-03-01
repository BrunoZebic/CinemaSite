import { pathToFileURL } from "node:url";
import { getStringFlag, parseArgs } from "./args";
import { loadLocalEnv } from "./env";
import { buildAuthKeySet, redactText, redactUrl, stripAuthParams } from "./redact";

const BLOCKED_UNSIGNED_STATUSES = new Set([401, 403, 404, 410]);
const M3U8_CONTENT_TYPE = /application\/vnd\.apple\.mpegurl|application\/x-mpegurl/i;

type GuardCheckResult = {
  label: string;
  url: string;
  status: number;
  passed: boolean;
  note: string;
};

export type TokenGuardResult = {
  ok: boolean;
  warnings: string[];
  checks: GuardCheckResult[];
};

type ParsedMediaPlaylist = {
  mapUri: string | null;
  keyUri: string | null;
  firstSegmentUri: string | null;
};

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

function parseUriAttribute(line: string): string | null {
  const match = line.match(/URI="([^"]+)"/i);
  return match?.[1] ?? null;
}

function toPlaylistLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function resolveUrl(baseUrl: string, maybeRelative: string): string {
  return new URL(maybeRelative, baseUrl).toString();
}

function mergeAuthParamsFromSignedSource(
  targetUrl: string,
  sourceSignedUrl: string,
  authKeys: Set<string>,
): string {
  const target = new URL(targetUrl);
  const source = new URL(sourceSignedUrl);

  if (target.protocol !== source.protocol || target.host !== source.host) {
    return target.toString();
  }

  for (const [key, value] of source.searchParams.entries()) {
    if (!authKeys.has(key.toLowerCase())) {
      continue;
    }
    if (!target.searchParams.has(key)) {
      target.searchParams.set(key, value);
    }
  }

  return target.toString();
}

function pickSignedMediaPlaylistUrl(
  masterUrl: string,
  masterContent: string,
): string | null {
  const lines = toPlaylistLines(masterContent);
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) {
      continue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate.startsWith("#")) {
        continue;
      }
      return resolveUrl(masterUrl, candidate);
    }
  }

  return null;
}

function parseMediaPlaylist(content: string): ParsedMediaPlaylist {
  const lines = toPlaylistLines(content);
  let mapUri: string | null = null;
  let keyUri: string | null = null;
  let firstSegmentUri: string | null = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP")) {
      mapUri = parseUriAttribute(line);
      continue;
    }

    if (line.startsWith("#EXT-X-KEY")) {
      const maybeUri = parseUriAttribute(line);
      if (maybeUri) {
        keyUri = maybeUri;
      }
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    if (!firstSegmentUri) {
      firstSegmentUri = line;
    }
  }

  return {
    mapUri,
    keyUri,
    firstSegmentUri,
  };
}

async function fetchWithStatus(
  url: string,
  options?: {
    rangeProbe?: boolean;
  },
): Promise<Response> {
  const headers = new Headers();
  if (options?.rangeProbe) {
    headers.set("Range", "bytes=0-1");
  }

  return fetch(url, {
    method: "GET",
    redirect: "manual",
    headers,
  });
}

function evaluateUnsignedStatus(status: number): { passed: boolean; note: string } {
  if (status >= 200 && status < 300) {
    return {
      passed: false,
      note: "Unsigned URL returned 2xx (public).",
    };
  }

  if (status >= 300 && status < 400) {
    return {
      passed: false,
      note: "Unsigned URL redirected (3xx), not definitively protected.",
    };
  }

  if (BLOCKED_UNSIGNED_STATUSES.has(status)) {
    return {
      passed: true,
      note: "Unsigned URL blocked as expected.",
    };
  }

  return {
    passed: false,
    note: `Unsigned URL returned unexpected status ${status}.`,
  };
}

function pushSignedWarnings(
  warnings: string[],
  label: string,
  response: Response,
): void {
  const contentType = response.headers.get("content-type") ?? "";
  const cors = response.headers.get("access-control-allow-origin");
  if (!M3U8_CONTENT_TYPE.test(contentType)) {
    warnings.push(
      `${label} content-type looked unusual (${contentType || "missing"}).`,
    );
  }
  if (!cors) {
    warnings.push(`${label} is missing access-control-allow-origin header.`);
  }
}

export async function assertTokenEnforcement(
  signedUrl: string,
  options?: {
    authKeyExtras?: string | null;
  },
): Promise<TokenGuardResult> {
  const authKeys = buildAuthKeySet(options?.authKeyExtras ?? null);
  const warnings: string[] = [];
  const checks: GuardCheckResult[] = [];
  const safeSignedUrl = redactUrl(signedUrl, authKeys);

  const masterResponse = await fetchWithStatus(signedUrl);
  if (!masterResponse.ok) {
    throw new Error(
      `Signed master request failed (${masterResponse.status}) for ${safeSignedUrl}.`,
    );
  }
  pushSignedWarnings(warnings, "Signed master", masterResponse);
  const masterText = await masterResponse.text();

  const maybeSignedMediaUrl = pickSignedMediaPlaylistUrl(signedUrl, masterText);
  const signedMediaUrl = maybeSignedMediaUrl
    ? mergeAuthParamsFromSignedSource(maybeSignedMediaUrl, signedUrl, authKeys)
    : signedUrl;

  let mediaText = masterText;
  if (maybeSignedMediaUrl) {
    const mediaResponse = await fetchWithStatus(signedMediaUrl);
    if (!mediaResponse.ok) {
      throw new Error(
        `Signed media playlist request failed (${mediaResponse.status}) for ${redactUrl(
          signedMediaUrl,
          authKeys,
        )}.`,
      );
    }
    pushSignedWarnings(warnings, "Signed media playlist", mediaResponse);
    mediaText = await mediaResponse.text();
  }

  const media = parseMediaPlaylist(mediaText);
  const primaryUri = media.mapUri ?? media.firstSegmentUri;

  if (!primaryUri) {
    throw new Error("Media playlist contained no EXT-X-MAP and no segment URI.");
  }

  const unsignedChecks: Array<{
    label: string;
    url: string;
    rangeProbe?: boolean;
  }> = [
    {
      label: "unsigned_master",
      url: stripAuthParams(signedUrl, authKeys),
    },
    {
      label: "unsigned_media_playlist",
      url: stripAuthParams(signedMediaUrl, authKeys),
    },
    {
      label: media.mapUri ? "unsigned_map_segment" : "unsigned_media_segment",
      url: stripAuthParams(resolveUrl(signedMediaUrl, primaryUri), authKeys),
      rangeProbe: true,
    },
  ];

  if (media.keyUri) {
    unsignedChecks.push({
      label: "unsigned_key",
      url: stripAuthParams(resolveUrl(signedMediaUrl, media.keyUri), authKeys),
      rangeProbe: true,
    });
  } else {
    warnings.push("No EXT-X-KEY URI found in media playlist.");
  }

  for (const check of unsignedChecks) {
    const response = await fetchWithStatus(check.url, {
      rangeProbe: Boolean(check.rangeProbe),
    });
    const evaluation = evaluateUnsignedStatus(response.status);
    checks.push({
      label: check.label,
      url: redactUrl(check.url, authKeys),
      status: response.status,
      passed: evaluation.passed,
      note: evaluation.note,
    });
  }

  return {
    ok: checks.every((check) => check.passed),
    warnings,
    checks,
  };
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const signedUrl =
    getStringFlag(args.flags, "url") ?? process.env.HLS_TEST_URL?.trim() ?? null;
  if (!signedUrl) {
    throw new Error("Provide --url or HLS_TEST_URL.");
  }

  const authKeyExtras =
    getStringFlag(args.flags, "auth-keys-extra") ??
    process.env.HLS_AUTH_KEYS_EXTRA ??
    null;

  const result = await assertTokenEnforcement(signedUrl, {
    authKeyExtras,
  });

  for (const warning of result.warnings) {
    process.stdout.write(`WARN ${warning}\n`);
  }

  for (const check of result.checks) {
    const statusWord = check.passed ? "PASS" : "FAIL";
    process.stdout.write(
      `${statusWord} ${check.label} status=${check.status} ${check.url} - ${check.note}\n`,
    );
  }

  if (!result.ok) {
    throw new Error("Token enforcement guard failed.");
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const rawMessage =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    const authKeys = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
    process.stderr.write(`${redactText(rawMessage, authKeys)}\n`);
    process.exitCode = 1;
  });
}
