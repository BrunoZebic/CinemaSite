import { createHash } from "crypto";

type ManifestPathResolutionInput = {
  manifestPath: string | null | undefined;
  legacyManifestUrl: string | null | undefined;
  cdnBaseUrl: string | null | undefined;
};

type ManifestPathResolutionSuccess = {
  ok: true;
  manifestPath: string;
};

type ManifestPathResolutionFailure = {
  ok: false;
  error: string;
};

export type ManifestPathResolutionResult =
  | ManifestPathResolutionSuccess
  | ManifestPathResolutionFailure;

const MANIFEST_EXTENSION = ".m3u8";

function reject(error: string): ManifestPathResolutionFailure {
  return {
    ok: false,
    error,
  };
}

function normalizePathSlashes(pathname: string): string {
  return pathname.replace(/\/{2,}/g, "/");
}

function validateManifestPath(rawPath: string): ManifestPathResolutionResult {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return reject("Missing HLS manifest path.");
  }
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return reject("Manifest path must be an absolute path starting with '/'.");
  }
  if (trimmed.includes("\\") || trimmed.includes("..")) {
    return reject("Manifest path contains invalid path traversal characters.");
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return reject("Manifest path must not contain query or hash values.");
  }
  if (trimmed.includes("://")) {
    return reject("Manifest path must not include protocol or hostname.");
  }
  if (/%2e/i.test(trimmed)) {
    return reject("Manifest path contains encoded dot segments.");
  }
  if (!trimmed.toLowerCase().endsWith(MANIFEST_EXTENSION)) {
    return reject("Manifest path must end with .m3u8.");
  }

  const normalized = normalizePathSlashes(trimmed);
  return {
    ok: true,
    manifestPath: normalized,
  };
}

function extractPathFromLegacyUrl(
  legacyManifestUrl: string,
  cdnBaseUrl: string | null | undefined,
): ManifestPathResolutionResult {
  if (!cdnBaseUrl) {
    return reject("BUNNY_CDN_BASE_URL is required for legacy manifest URL migration.");
  }

  let legacyUrl: URL;
  let baseUrl: URL;

  try {
    legacyUrl = new URL(legacyManifestUrl);
    baseUrl = new URL(cdnBaseUrl);
  } catch {
    return reject("Invalid manifest URL or CDN base URL.");
  }

  if (legacyUrl.origin !== baseUrl.origin) {
    return reject("Legacy manifest URL host does not match BUNNY_CDN_BASE_URL.");
  }
  if (legacyUrl.search || legacyUrl.hash) {
    return reject("Legacy manifest URL must not contain query or hash values.");
  }

  return validateManifestPath(legacyUrl.pathname);
}

export function resolveManifestPath(
  input: ManifestPathResolutionInput,
): ManifestPathResolutionResult {
  if (input.manifestPath) {
    return validateManifestPath(input.manifestPath);
  }
  if (input.legacyManifestUrl) {
    return extractPathFromLegacyUrl(input.legacyManifestUrl, input.cdnBaseUrl);
  }
  return reject("Missing HLS manifest configuration for this screening.");
}

function toBase64UrlSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("base64url");
}

function ensureDirectoryTokenPath(manifestPath: string): string {
  const lastSlashIndex = manifestPath.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return "/";
  }

  let directory = manifestPath.slice(0, lastSlashIndex + 1);
  if (!directory.startsWith("/")) {
    directory = `/${directory}`;
  }
  if (!directory.endsWith("/")) {
    directory = `${directory}/`;
  }
  return normalizePathSlashes(directory);
}

type SignManifestInput = {
  cdnBaseUrl: string;
  manifestPath: string;
  tokenKey: string;
  expiresInSeconds: number;
  nowUnixMs?: number;
};

export function createSignedBunnyManifestUrl({
  cdnBaseUrl,
  manifestPath,
  tokenKey,
  expiresInSeconds,
  nowUnixMs = Date.now(),
}: SignManifestInput): string {
  const validated = validateManifestPath(manifestPath);
  if (!validated.ok) {
    throw new Error(validated.error);
  }

  const base = cdnBaseUrl.replace(/\/+$/, "");
  const expires = Math.floor(nowUnixMs / 1000) + Math.max(60, expiresInSeconds);
  const tokenPath = ensureDirectoryTokenPath(validated.manifestPath);
  const signedParameters = `token_path=${tokenPath}`;
  const signatureInput = `${tokenKey}${tokenPath}${expires}${signedParameters}`;
  const token = toBase64UrlSha256(signatureInput);
  const tokenPathEncoded = encodeURIComponent(tokenPath);

  return `${base}/bcdn_token=${token}&expires=${expires}&token_path=${tokenPathEncoded}${validated.manifestPath}`;
}
