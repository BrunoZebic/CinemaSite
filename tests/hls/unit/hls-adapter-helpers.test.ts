import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAuthParams,
  buildManifestAuthContext,
  mapHlsFatalEvent,
  normalizeSeekTarget,
} from "../../../lib/video/hlsAdapterCore";

test("appendAuthParams appends same-origin auth params for relative URLs", () => {
  const authContext = buildManifestAuthContext(
    "https://cdn.example.com/master.m3u8?token=abc&expires=123",
  );

  assert.equal(
    appendAuthParams("media/playlist.m3u8", authContext),
    "https://cdn.example.com/media/playlist.m3u8?token=abc&expires=123",
  );
});

test("appendAuthParams preserves existing auth params and never overwrites them", () => {
  const authContext = buildManifestAuthContext(
    "https://cdn.example.com/master.m3u8?token=abc&expires=123",
  );

  assert.equal(
    appendAuthParams(
      "https://cdn.example.com/chunk.m4s?token=own-token&part=1",
      authContext,
    ),
    "https://cdn.example.com/chunk.m4s?token=own-token&part=1&expires=123",
  );
});

test("appendAuthParams leaves cross-origin URLs unchanged", () => {
  const authContext = buildManifestAuthContext(
    "https://cdn.example.com/master.m3u8?token=abc&expires=123",
  );

  assert.equal(
    appendAuthParams("https://other.example.com/segment.ts?part=2", authContext),
    "https://other.example.com/segment.ts?part=2",
  );
});

test("appendAuthParams returns invalid raw URLs unchanged", () => {
  const authContext = buildManifestAuthContext(
    "https://cdn.example.com/master.m3u8?token=abc&expires=123",
  );

  assert.equal(appendAuthParams("http://%zz", authContext), "http://%zz");
});

test("buildManifestAuthContext throws for malformed or non-absolute manifest URLs", () => {
  assert.throws(() => buildManifestAuthContext("/master.m3u8"));
  assert.throws(() => buildManifestAuthContext("::bad-url::"));
});

test("mapHlsFatalEvent treats 401 and 403 as fatal even when fatal=false", () => {
  assert.deepEqual(
    mapHlsFatalEvent({
      fatal: false,
      response: { code: 401 },
      details: "manifestLoadError",
    }),
    {
      statusCode: 401,
      details: "manifestLoadError",
      isForbidden: true,
    },
  );

  assert.deepEqual(
    mapHlsFatalEvent({
      fatal: false,
      response: { code: 403 },
      details: "fragLoadError",
    }),
    {
      statusCode: 403,
      details: "fragLoadError",
      isForbidden: true,
    },
  );
});

test("mapHlsFatalEvent maps fatal non-forbidden errors", () => {
  assert.deepEqual(
    mapHlsFatalEvent({
      fatal: true,
      response: { code: 503 },
      details: "manifestLoadError",
    }),
    {
      statusCode: 503,
      details: "manifestLoadError",
      isForbidden: false,
    },
  );
});

test("mapHlsFatalEvent ignores nonfatal non-forbidden errors", () => {
  assert.equal(
    mapHlsFatalEvent({
      fatal: false,
      response: { code: 500 },
      details: "fragLoadError",
    }),
    null,
  );
});

test("normalizeSeekTarget clamps negative and non-finite values", () => {
  assert.equal(normalizeSeekTarget(-5), 0);
  assert.equal(normalizeSeekTarget(Number.NaN), 0);
  assert.equal(normalizeSeekTarget(12.5), 12.5);
});
