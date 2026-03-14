import assert from "node:assert/strict";
import test from "node:test";
import {
  detectNativeHlsSupport,
  isLikelySafariWebKit,
  manifestParsedForEngine,
  selectHlsEngine,
} from "../../../lib/video/hlsEngineSelection";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";
const EDGE_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0";
const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0";
const SAFARI_MAC_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const SAFARI_IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test("detects likely Safari/WebKit conservatively", () => {
  assert.equal(isLikelySafariWebKit(SAFARI_MAC_UA), true);
  assert.equal(isLikelySafariWebKit(SAFARI_IOS_UA), true);
  assert.equal(isLikelySafariWebKit(CHROME_UA), false);
  assert.equal(isLikelySafariWebKit(EDGE_UA), false);
  assert.equal(isLikelySafariWebKit(FIREFOX_UA), false);
});

test("prefers hls.js on Chromium-family even when nativeCanPlay is true", () => {
  assert.equal(
    selectHlsEngine({
      userAgent: CHROME_UA,
      hlsJsSupported: true,
      nativeCanPlay: true,
    }),
    "hls.js",
  );
  assert.equal(
    selectHlsEngine({
      userAgent: EDGE_UA,
      hlsJsSupported: true,
      nativeCanPlay: true,
    }),
    "hls.js",
  );
});

test("prefers hls.js on Firefox when supported", () => {
  assert.equal(
    selectHlsEngine({
      userAgent: FIREFOX_UA,
      hlsJsSupported: true,
      nativeCanPlay: true,
    }),
    "hls.js",
  );
});

test("prefers native on Safari/WebKit when native playback is available", () => {
  assert.equal(
    selectHlsEngine({
      userAgent: SAFARI_MAC_UA,
      hlsJsSupported: true,
      nativeCanPlay: true,
    }),
    "native",
  );
  assert.equal(
    selectHlsEngine({
      userAgent: SAFARI_IOS_UA,
      hlsJsSupported: true,
      nativeCanPlay: true,
    }),
    "native",
  );
});

test("falls back to native only when hls.js is unavailable", () => {
  assert.equal(
    selectHlsEngine({
      userAgent: CHROME_UA,
      hlsJsSupported: false,
      nativeCanPlay: true,
    }),
    "native",
  );
});

test("returns unsupported when no engine is available", () => {
  assert.equal(
    selectHlsEngine({
      userAgent: CHROME_UA,
      hlsJsSupported: false,
      nativeCanPlay: false,
    }),
    "unsupported",
  );
});

test("detectNativeHlsSupport returns first matching MIME alias", () => {
  const support = detectNativeHlsSupport((mimeType) => {
    if (mimeType === "application/x-mpegURL") {
      return "maybe";
    }
    return "";
  });

  assert.deepEqual(support, {
    canPlay: true,
    mimeType: "application/x-mpegURL",
  });
});

test("detectNativeHlsSupport returns primary MIME alias when supported", () => {
  const support = detectNativeHlsSupport((mimeType) =>
    mimeType === "application/vnd.apple.mpegurl" ? "probably" : "",
  );

  assert.deepEqual(support, {
    canPlay: true,
    mimeType: "application/vnd.apple.mpegurl",
  });
});

test("detectNativeHlsSupport returns unsupported when all aliases fail", () => {
  const support = detectNativeHlsSupport(() => "");

  assert.deepEqual(support, {
    canPlay: false,
    mimeType: null,
  });
});

test("manifestParsed is treated as hls.js-only semantics", () => {
  assert.equal(manifestParsedForEngine("hls.js", true), true);
  assert.equal(manifestParsedForEngine("hls.js", false), false);
  assert.equal(manifestParsedForEngine("native", true), false);
  assert.equal(manifestParsedForEngine("native", false), false);
  assert.equal(manifestParsedForEngine("unsupported", true), false);
});
