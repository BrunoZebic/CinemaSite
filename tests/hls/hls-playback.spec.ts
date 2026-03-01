import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  expect,
  test,
  type Page,
  type Response,
  type Request,
} from "@playwright/test";
import { startHlsTestServer } from "./server";
import { buildAuthKeySet, redactText, redactUnknown, redactUrl } from "../../scripts/hls/redact";

type SmokeFailureClass =
  | "timeout"
  | "network_error"
  | "http_5xx"
  | "http_4xx"
  | "unknown";

type SmokeResultFile = {
  ok: boolean;
  failureClass?: SmokeFailureClass;
  message?: string;
};

type HlsBrowserMetrics = {
  manifestParsed: boolean;
  fragsLoaded: number;
  segment2xx: number;
  fatalErrors: unknown[];
  mediaErrors: unknown[];
};

const MANIFEST_TIMEOUT_MS = 10_000;
const PLAYBACK_PROGRESS_TIMEOUT_MS = 45_000;
const POST_PROGRESS_WAIT_MS = 2_000;
const POST_PROGRESS_DELTA_MIN = 0.2;
const SMOKE_PORT = Number(process.env.HLS_SMOKE_PORT ?? 4173);
const AUTH_KEYS = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
const MEDIA_EXTENSION_PATTERN = /\.(m3u8|ts|m4s|mp4|key)(\?|$)/i;
const MEDIA_CONTENT_TYPE_PATTERN = /mpegurl|mp2t|mp4|octet-stream/i;

function isMediaRequest(request: Request): boolean {
  const url = request.url();
  if (MEDIA_EXTENSION_PATTERN.test(url)) {
    return true;
  }

  const accept = request.headers()["accept"];
  return typeof accept === "string" && /mpegurl|video|audio/i.test(accept);
}

function isMediaResponse(response: Response): boolean {
  const url = response.url();
  if (MEDIA_EXTENSION_PATTERN.test(url)) {
    return true;
  }
  const contentType = response.headers()["content-type"] ?? "";
  return MEDIA_CONTENT_TYPE_PATTERN.test(contentType);
}

function classifyFailure(
  failureMessage: string,
  requestFailures: Array<{ errorText: string }>,
  responseStatuses: number[],
): SmokeFailureClass {
  if (/timed out|timeout/i.test(failureMessage)) {
    return "timeout";
  }

  if (
    requestFailures.some((entry) => /net::ERR_[A-Z_]+|NS_ERROR_/i.test(entry.errorText))
  ) {
    return "network_error";
  }

  if (responseStatuses.some((status) => status >= 500)) {
    return "http_5xx";
  }

  if (responseStatuses.some((status) => status >= 400 && status < 500)) {
    return "http_4xx";
  }

  return "unknown";
}

async function writeSmokeResult(result: SmokeResultFile): Promise<void> {
  const file = process.env.HLS_SMOKE_RESULT_FILE;
  if (!file) {
    return;
  }

  await writeFile(path.resolve(file), JSON.stringify(result), "utf8");
}

async function readMetrics(page: Page): Promise<HlsBrowserMetrics> {
  return page.evaluate(() => {
    const raw = (window as unknown as { __HLS_METRICS__?: HlsBrowserMetrics })
      .__HLS_METRICS__;
    return (
      raw ?? {
        manifestParsed: false,
        fragsLoaded: 0,
        segment2xx: 0,
        fatalErrors: [],
        mediaErrors: [],
      }
    );
  });
}

test("HLS smoke playback advances and loads fragments", async ({ page }) => {
  test.setTimeout(90_000);
  const sourceUrl = process.env.HLS_TEST_URL?.trim();
  expect(sourceUrl, "Provide HLS_TEST_URL for smoke playback.").toBeTruthy();

  const authExtras = process.env.HLS_AUTH_KEYS_EXTRA?.trim() ?? "";
  const requestFailures: Array<{ url: string; errorText: string }> = [];
  const mediaResponses: Array<{ url: string; status: number; contentType: string }> = [];
  const browserLogs: Array<{ type: string; text: string }> = [];

  page.on("console", (msg) => {
    const text = redactText(msg.text(), AUTH_KEYS);
    browserLogs.push({
      type: msg.type(),
      text,
    });
  });

  page.on("requestfailed", (request) => {
    if (!isMediaRequest(request)) {
      return;
    }
    requestFailures.push({
      url: redactUrl(request.url(), AUTH_KEYS),
      errorText: request.failure()?.errorText ?? "unknown request failure",
    });
  });

  page.on("response", (response) => {
    if (!isMediaResponse(response)) {
      return;
    }
    mediaResponses.push({
      url: redactUrl(response.url(), AUTH_KEYS),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? "",
    });
  });

  const server = await startHlsTestServer({
    port: SMOKE_PORT,
    bindHost: "127.0.0.1",
    originHost: "localhost",
  });

  process.stdout.write(`SMOKE_ORIGIN=${server.baseUrl}\n`);

  try {
    const testUrl = `${server.baseUrl}/player.html?src=${encodeURIComponent(
      sourceUrl!,
    )}&auth_keys=${encodeURIComponent(authExtras)}`;
    await page.goto(testUrl, {
      waitUntil: "domcontentloaded",
    });

    await expect
      .poll(
        async () => {
          const metrics = await readMetrics(page);
          const fatal = await page.evaluate(
            () =>
              (window as unknown as { __HLS_FATAL__?: unknown }).__HLS_FATAL__ ?? null,
          );
          if (fatal) {
            return {
              ok: false,
              reason: "fatal",
              fatal,
              metrics,
            };
          }
          return {
            ok: metrics.manifestParsed,
            reason: metrics.manifestParsed ? "manifest_parsed" : "waiting",
            metrics,
          };
        },
        {
          timeout: MANIFEST_TIMEOUT_MS,
          intervals: [200, 500, 1_000],
        },
      )
      .toMatchObject({
        ok: true,
      });

    await expect
      .poll(
        async () => {
          const metrics = await readMetrics(page);
          const state = await page.evaluate(
            () =>
              (window as unknown as {
                __HLS_STATE__?: { currentTime: number; readyState: number; paused: boolean };
              }).__HLS_STATE__ ?? { currentTime: 0, readyState: 0, paused: true },
          );
          const fatal = await page.evaluate(
            () =>
              (window as unknown as { __HLS_FATAL__?: unknown }).__HLS_FATAL__ ?? null,
          );
          if (fatal) {
            return {
              ok: false,
              reason: "fatal",
              fatal,
              metrics,
              state,
            };
          }
          return {
            ok: state.currentTime > 1 && metrics.fragsLoaded >= 1,
            reason: "progress_gate_a",
            metrics,
            state,
          };
        },
        {
          timeout: PLAYBACK_PROGRESS_TIMEOUT_MS,
          intervals: [250, 500, 1_000],
        },
      )
      .toMatchObject({
        ok: true,
      });

    const before = await page.evaluate(
      () =>
        (window as unknown as { __HLS_STATE__?: { currentTime: number } }).__HLS_STATE__
          ?.currentTime ?? 0,
    );
    await page.waitForTimeout(POST_PROGRESS_WAIT_MS);
    const after = await page.evaluate(
      () =>
        (window as unknown as { __HLS_STATE__?: { currentTime: number } }).__HLS_STATE__
          ?.currentTime ?? 0,
    );

    expect(after - before).toBeGreaterThanOrEqual(POST_PROGRESS_DELTA_MIN);

    await writeSmokeResult({
      ok: true,
    });
  } catch (error: unknown) {
    const rawMessage =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    const metrics = await readMetrics(page).catch(() => ({
      manifestParsed: false,
      fragsLoaded: 0,
      segment2xx: 0,
      fatalErrors: [],
      mediaErrors: [],
    }));

    const failureClass = classifyFailure(
      rawMessage,
      requestFailures,
      mediaResponses.map((entry) => entry.status),
    );

    const diagnostics = {
      failureClass,
      message: redactText(rawMessage, AUTH_KEYS),
      metrics: redactUnknown(metrics, AUTH_KEYS),
      requestFailures: redactUnknown(requestFailures, AUTH_KEYS),
      mediaResponses: redactUnknown(mediaResponses, AUTH_KEYS),
      browserLogs: redactUnknown(browserLogs, AUTH_KEYS),
      hint: `CORS/network failures often mean Bunny is not allowing ${server.baseUrl}. Check Bunny CORS for this exact origin string.`,
    };

    process.stderr.write(`${JSON.stringify(diagnostics, null, 2)}\n`);

    await writeSmokeResult({
      ok: false,
      failureClass,
      message: diagnostics.message,
    });

    throw error;
  } finally {
    await server.close();
  }
});
