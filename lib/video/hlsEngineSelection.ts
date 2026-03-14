export const HLS_MIME_TYPE = "application/vnd.apple.mpegurl";
export const NATIVE_HLS_MIME_TYPES = [
  HLS_MIME_TYPE,
  "application/x-mpegURL",
  "audio/mpegurl",
] as const;

export type HlsPlaybackEngine = "hls.js" | "native" | "unsupported";
export type NativeHlsSupport = {
  canPlay: boolean;
  mimeType: string | null;
};

export type HlsEngineSelectionInput = {
  userAgent: string;
  hlsJsSupported: boolean;
  nativeCanPlay: boolean;
};

const APPLE_WEBKIT_PATTERN = /AppleWebKit/i;
const SAFARI_PATTERN = /Safari/i;
const APPLE_PLATFORM_PATTERN = /Macintosh|iPhone|iPad|iPod/i;
const NON_SAFARI_WEBKIT_PATTERN =
  /Chrome|Chromium|CriOS|FxiOS|Edg|EdgiOS|EdgA|OPR|OPiOS|SamsungBrowser|UCBrowser|YaBrowser/i;

export function isLikelySafariWebKit(userAgent: string): boolean {
  const ua = userAgent.trim();
  if (!ua) {
    return false;
  }

  if (!APPLE_WEBKIT_PATTERN.test(ua)) {
    return false;
  }

  if (!SAFARI_PATTERN.test(ua)) {
    return false;
  }

  if (!APPLE_PLATFORM_PATTERN.test(ua)) {
    return false;
  }

  return !NON_SAFARI_WEBKIT_PATTERN.test(ua);
}

export function selectHlsEngine(
  input: HlsEngineSelectionInput,
): HlsPlaybackEngine {
  if (isLikelySafariWebKit(input.userAgent) && input.nativeCanPlay) {
    return "native";
  }

  if (input.hlsJsSupported) {
    return "hls.js";
  }

  if (input.nativeCanPlay) {
    return "native";
  }

  return "unsupported";
}

export function detectNativeHlsSupport(
  canPlayType: (mimeType: string) => string,
): NativeHlsSupport {
  for (const mimeType of NATIVE_HLS_MIME_TYPES) {
    if (canPlayType(mimeType).trim() !== "") {
      return {
        canPlay: true,
        mimeType,
      };
    }
  }

  return {
    canPlay: false,
    mimeType: null,
  };
}

export function manifestParsedForEngine(
  engine: HlsPlaybackEngine,
  manifestParsed: boolean,
): boolean {
  return engine === "hls.js" && manifestParsed;
}
