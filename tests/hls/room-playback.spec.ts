import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { loadLocalEnv } from "../../scripts/hls/env";
import { buildAuthKeySet, redactUnknown } from "../../scripts/hls/redact";

loadLocalEnv();

const AUTH_KEYS = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
const ROOM =
  process.env.HLS_TEST_ROOM?.trim() ?? process.env.HLS_E2E_ROOM?.trim() ?? "demo";
const BASE_URL =
  process.env.HLS_TEST_BASE_URL?.trim() ??
  process.env.HLS_E2E_BASE_URL?.trim() ??
  "http://localhost:3100";
const INVITE_CODE =
  process.env.HLS_TEST_INVITE_CODE?.trim() ??
  process.env.HLS_E2E_INVITE_CODE?.trim() ??
  "";
const IDLE_DELAY_MS = Number(process.env.HLS_E2E_IDLE_DELAY_MS ?? 10_000);
const STABILITY_WINDOW_MS = Number(process.env.HLS_E2E_STABILITY_WINDOW_MS ?? 10_000);
const STARTUP_PRE_GATE_TIMEOUT_MS = Number(
  process.env.HLS_E2E_STARTUP_PRE_GATE_TIMEOUT_MS ?? 12_000,
);
const PRIMARY_PROGRESS_DELTA_MIN_SEC = 4;
const SECONDARY_PROGRESS_DELTA_MIN_SEC = 5;
const WAITING_STALLED_SOFT_LIMIT = 2;
const MANIFEST_SOURCE_PATTERN = /\.m3u8(?:$|[?#])/i;

type RuntimeProbeState = {
  playbackEngine?: string;
  manifestParsed?: boolean;
  nativeMetadataLoaded?: boolean;
  readinessStage?: string;
  readyState?: number;
  buffering?: boolean;
  recoveryState?: string;
  playbackStartState?: string;
};

type VideoDiagnostics = {
  currentSrc: string;
  srcAttr: string | null;
  readyState: number;
  networkState: number;
  currentTime: number;
  paused: boolean;
  error: { code: number } | null;
  probe: RuntimeProbeState | null;
};

function roomUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/premiere/${encodeURIComponent(ROOM)}`;
}

function hasManifestSource(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  return MANIFEST_SOURCE_PATTERN.test(value);
}

async function readVideoDiagnostics(page: Page): Promise<VideoDiagnostics> {
  return page.evaluate(() => {
    const media = document.querySelector(
      '[data-testid="hls-video"]',
    ) as HTMLVideoElement | null;

    const probe = (window as unknown as { __HLS_E2E_PROBE__?: RuntimeProbeState })
      .__HLS_E2E_PROBE__;

    if (!media) {
      return {
        currentSrc: "",
        srcAttr: null,
        readyState: 0,
        networkState: 0,
        currentTime: 0,
        paused: true,
        error: null,
        probe: probe ?? null,
      };
    }

    return {
      currentSrc: media.currentSrc,
      srcAttr: media.getAttribute("src"),
      readyState: media.readyState,
      networkState: media.networkState,
      currentTime: media.currentTime,
      paused: media.paused,
      error: media.error ? { code: media.error.code } : null,
      probe: probe ?? null,
    };
  });
}

async function attachDiagnostics(
  page: Page,
  testInfo: TestInfo,
  stage: string,
  reason: string,
): Promise<void> {
  const diagnostics = await readVideoDiagnostics(page).catch(() => ({
    currentSrc: "",
    srcAttr: null,
    readyState: 0,
    networkState: 0,
    currentTime: 0,
    paused: true,
    error: null,
    probe: null,
  }));

  const safePayload = redactUnknown(
    {
      stage,
      reason,
      diagnostics,
    },
    AUTH_KEYS,
  );

  await testInfo.attach(`room-${stage}-diagnostics`, {
    body: JSON.stringify(safePayload, null, 2),
    contentType: "application/json",
  });
}

async function completeInviteFlow(page: Page): Promise<void> {
  const inviteInput = page.getByTestId("invite-code-input");
  await expect(inviteInput).toBeVisible({
    timeout: 20_000,
  });
  await inviteInput.fill(INVITE_CODE);
  await page.getByTestId("invite-submit").click();
  await expect(inviteInput).toBeHidden({
    timeout: 20_000,
  });
}

async function maybeHandleIdentityModal(page: Page): Promise<void> {
  const identityInput = page.getByTestId("identity-nickname-input");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const visible = await identityInput.isVisible().catch(() => false);
    if (!visible) {
      await page.waitForTimeout(200);
      continue;
    }

    await identityInput.fill("Week4Tester");
    await page.getByTestId("identity-submit").click();
    await expect(identityInput).toBeHidden({
      timeout: 10_000,
    });
    return;
  }
}

async function clickGestureIfVisible(page: Page): Promise<void> {
  const gestureCta = page.getByTestId("gesture-play-cta");
  if (!(await gestureCta.isVisible().catch(() => false))) {
    return;
  }

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await gestureCta.click({
        timeout: 6_000,
      });
      return;
    } catch (error) {
      lastError = error;
      await maybeHandleIdentityModal(page);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to click gesture CTA.");
}

async function waitForPlaybackProgress(
  page: Page,
  testInfo: TestInfo,
  stage: string,
): Promise<void> {
  const video = page.getByTestId("hls-video");
  await expect(video).toBeVisible({
    timeout: 45_000,
  });

  try {
    await expect
      .poll(
        async () =>
          video.evaluate(
            (element) => (element as HTMLVideoElement).currentTime || 0,
          ),
        {
          timeout: 45_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toBeGreaterThan(1);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      stage,
      "Playback progress gate timed out (expected currentTime > 1).",
    );
    throw error;
  }
}

async function assertChromiumEnginePath(
  page: Page,
  browserName: string,
  testInfo: TestInfo,
): Promise<void> {
  if (browserName !== "chromium") {
    return;
  }

  const firstSnapshot = await readVideoDiagnostics(page);
  if (
    hasManifestSource(firstSnapshot.currentSrc) ||
    hasManifestSource(firstSnapshot.srcAttr)
  ) {
    await attachDiagnostics(
      page,
      testInfo,
      "engine_path",
      "Detected native HLS path on Chromium; expected hls.js attachment.",
    );
    throw new Error(
      "Detected native HLS path on Chromium; expected hls.js attachment.",
    );
  }

  try {
    await expect
      .poll(
        async () => {
          const snapshot = await readVideoDiagnostics(page);
          const hasNativePath =
            hasManifestSource(snapshot.currentSrc) ||
            hasManifestSource(snapshot.srcAttr);
          const hasBlobPath = snapshot.currentSrc.startsWith("blob:");
          const probeConfirmsHlsJs =
            snapshot.probe?.playbackEngine === "hls.js" &&
            snapshot.probe?.manifestParsed === true;

          return !hasNativePath && (hasBlobPath || probeConfirmsHlsJs);
        },
        {
          timeout: STARTUP_PRE_GATE_TIMEOUT_MS,
          intervals: [250, 500, 1_000],
          message:
            "Chromium engine guard failed: expected hls.js path (blob currentSrc or probe manifestParsed=true) and no native .m3u8 source.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "engine_path",
      "Chromium engine path guard did not observe hls.js attachment in time.",
    );
    throw error;
  }
}

async function assertPlaybackNotStuck(
  page: Page,
  testInfo: TestInfo,
): Promise<void> {
  const video = page.getByTestId("hls-video");
  await expect(video).toBeVisible({ timeout: 45_000 });

  try {
    await expect
      .poll(
        async () => {
          const state = await video.evaluate((element) => ({
            readyState: (element as HTMLVideoElement).readyState ?? 0,
            currentTime: (element as HTMLVideoElement).currentTime ?? 0,
          }));
          return state.readyState >= 2 || state.currentTime > 0.2;
        },
        {
          timeout: STARTUP_PRE_GATE_TIMEOUT_MS,
          intervals: [250, 500, 1_000],
          message:
            "Startup stuck: expected readyState>=2 or currentTime>0.2 after gesture.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "startup_not_stuck",
      "Startup readiness pre-gate timed out.",
    );
    throw error;
  }
}

async function skipIfRoomNotPlayable(page: Page): Promise<void> {
  const isClosed = await page
    .getByText("Screening has closed.")
    .isVisible()
    .catch(() => false);
  const isDiscussion = await page
    .getByText("Discussion phase is open.")
    .isVisible()
    .catch(() => false);

  test.skip(
    isClosed || isDiscussion,
    `Room "${ROOM}" is not in a playable phase (WAITING/LIVE required).`,
  );
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test.describe("Room Playback", () => {
  test.skip(!INVITE_CODE, "Missing HLS_TEST_INVITE_CODE.");

  test("room playback reaches advancing video time", async (
    { page, browserName },
    testInfo,
  ) => {
    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await completeInviteFlow(page);
    await maybeHandleIdentityModal(page);
    await skipIfRoomNotPlayable(page);

    await clickGestureIfVisible(page);
    await assertChromiumEnginePath(page, browserName, testInfo);
    await assertPlaybackNotStuck(page, testInfo);
    await waitForPlaybackProgress(page, testInfo, "playback_progress_primary");
  });

  test("cookie bypass reload + delayed gesture start remains stable", async (
    { page, browserName },
    testInfo,
  ) => {
    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await completeInviteFlow(page);
    await maybeHandleIdentityModal(page);
    await skipIfRoomNotPlayable(page);
    await assertChromiumEnginePath(page, browserName, testInfo);
    await waitForPlaybackProgress(page, testInfo, "playback_progress_pre_reload");

    await page.reload({
      waitUntil: "domcontentloaded",
    });
    await maybeHandleIdentityModal(page);
    await expect(page.getByTestId("invite-code-input")).toBeHidden({
      timeout: 10_000,
    });

    const video = page.getByTestId("hls-video");
    await expect(video).toBeVisible({
      timeout: 45_000,
    });

    await page.evaluate(() => {
      const media = document.querySelector(
        '[data-testid="hls-video"]',
      ) as HTMLVideoElement | null;
      if (!media) {
        throw new Error("Missing hls video element for stability probe.");
      }

      const win = window as unknown as {
        __HLS_E2E_METRICS__?: { waiting: number; stalled: number };
      };

      if (!win.__HLS_E2E_METRICS__) {
        win.__HLS_E2E_METRICS__ = {
          waiting: 0,
          stalled: 0,
        };
        media.addEventListener("waiting", () => {
          if (!win.__HLS_E2E_METRICS__) {
            return;
          }
          win.__HLS_E2E_METRICS__.waiting += 1;
        });
        media.addEventListener("stalled", () => {
          if (!win.__HLS_E2E_METRICS__) {
            return;
          }
          win.__HLS_E2E_METRICS__.stalled += 1;
        });
      } else {
        win.__HLS_E2E_METRICS__.waiting = 0;
        win.__HLS_E2E_METRICS__.stalled = 0;
      }
    });

    await page.waitForTimeout(IDLE_DELAY_MS);

    await clickGestureIfVisible(page);
    await assertChromiumEnginePath(page, browserName, testInfo);
    await assertPlaybackNotStuck(page, testInfo);
    await waitForPlaybackProgress(page, testInfo, "playback_progress_post_reload");

    const startTime = await video.evaluate(
      (element) => (element as HTMLVideoElement).currentTime || 0,
    );

    await page.waitForTimeout(STABILITY_WINDOW_MS);

    const [endTime, paused, metrics] = await Promise.all([
      video.evaluate((element) => (element as HTMLVideoElement).currentTime || 0),
      video.evaluate((element) => (element as HTMLVideoElement).paused),
      page.evaluate(() => {
        const win = window as unknown as {
          __HLS_E2E_METRICS__?: { waiting: number; stalled: number };
        };
        return (
          win.__HLS_E2E_METRICS__ ?? {
            waiting: 0,
            stalled: 0,
          }
        );
      }),
    ]);

    const progressDelta = endTime - startTime;
    const instabilityCount = metrics.waiting + metrics.stalled;

    expect(paused).toBe(false);
    expect(progressDelta).toBeGreaterThanOrEqual(PRIMARY_PROGRESS_DELTA_MIN_SEC);

    if (instabilityCount > WAITING_STALLED_SOFT_LIMIT) {
      expect(progressDelta).toBeGreaterThanOrEqual(SECONDARY_PROGRESS_DELTA_MIN_SEC);
    }
  });
});
