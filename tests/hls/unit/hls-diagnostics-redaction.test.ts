import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAuthKeySet,
  redactText,
  redactUnknown,
  redactUrl,
} from "../../../scripts/hls/redact";

test("redactUrl masks known auth query params and preserves others", () => {
  const authKeys = buildAuthKeySet(null);
  const redacted = redactUrl(
    "https://cinema-cdn.b-cdn.net/screenings/demo/master.m3u8?token=abc&expires=123&token_path=%2Fscreenings%2Fdemo%2F&foo=bar",
    authKeys,
  );

  assert.match(redacted, /token=REDACTED/);
  assert.match(redacted, /expires=REDACTED/);
  assert.match(redacted, /token_path=REDACTED/);
  assert.match(redacted, /foo=bar/);
  assert.doesNotMatch(redacted, /token=abc/);
});

test("redactText redacts URLs embedded in plain text messages", () => {
  const authKeys = buildAuthKeySet(null);
  const redacted = redactText(
    "Failed URL https://example.com/master.m3u8?token=my-token&expires=9999",
    authKeys,
  );

  assert.match(redacted, /token=REDACTED/);
  assert.match(redacted, /expires=REDACTED/);
  assert.doesNotMatch(redacted, /my-token/);
});

test("redactUnknown recursively redacts nested diagnostics payloads", () => {
  const authKeys = buildAuthKeySet("custom_auth");
  const payload = {
    mediaResponses: [
      {
        url: "https://example.com/seg.ts?token=a&custom_auth=b&other=ok",
      },
    ],
    requestFailures: {
      lastUrl:
        "https://example.com/master.m3u8?bcdn_token=signed&expires=1234&token_path=%2Fx%2F",
    },
    note: "See https://example.com/path?token=plain-text",
  };

  const redacted = redactUnknown(payload, authKeys) as {
    mediaResponses: Array<{ url: string }>;
    requestFailures: { lastUrl: string };
    note: string;
  };

  assert.match(redacted.mediaResponses[0].url, /token=REDACTED/);
  assert.match(redacted.mediaResponses[0].url, /custom_auth=REDACTED/);
  assert.match(redacted.mediaResponses[0].url, /other=ok/);
  assert.match(redacted.requestFailures.lastUrl, /bcdn_token=REDACTED/);
  assert.match(redacted.requestFailures.lastUrl, /expires=REDACTED/);
  assert.match(redacted.requestFailures.lastUrl, /token_path=REDACTED/);
  assert.match(redacted.note, /token=REDACTED/);
});
