import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  INVITE_CODE,
  attachRoomDiagnostics,
  completeIdentityFlow,
  completeInviteFlow,
  readNativeHlsCapability,
  readRoomVideoDiagnostics,
  roomUrl,
  skipIfRoomNotPlayable,
  type NativeHlsCapability,
} from "./room-e2e-shared";

const REQUIRE_WEBKIT_HLS = process.env.HLS_E2E_REQUIRE_WEBKIT_HLS === "1";
const IDLE_DELAY_MS = Number(process.env.HLS_E2E_IDLE_DELAY_MS ?? 10_000);
const STABILITY_WINDOW_MS = Number(process.env.HLS_E2E_STABILITY_WINDOW_MS ?? 10_000);
const STARTUP_TIMEOUT_MS = Number(
  process.env.HLS_E2E_STARTUP_PRE_GATE_TIMEOUT_MS ?? 12_000,
);
const PLAYBACK_TIMEOUT_MS = 45_000;
const PRIMARY_PROGRESS_DELTA_MIN_SEC = 4;
const SECONDARY_PROGRESS_DELTA_MIN_SEC = 5;
const WAITING_STALLED_SOFT_LIMIT = 2;

async function ensureNativeHlsCapability(
  page: Page,
  testInfo: TestInfo,
  stage: string,
): Promise<NativeHlsCapability> {
  const capability = await readNativeHlsCapability(page);
  if (capability.nativeCanPlayHls) {
    return capability;
  }

  await attachRoomDiagnostics(
    page,
    testInfo,
    stage,
    "WebKit runtime does not report native HLS support for room playback validation.",
    {
      nativeCapability: capability,
    },
  );

  if (REQUIRE_WEBKIT_HLS) {
    throw new Error(
      "WebKit runtime does not report native HLS support and HLS_E2E_REQUIRE_WEBKIT_HLS=1 is enabled.",
    );
  }

  test.skip(
    true,
    "WebKit runtime does not report native HLS support; skipping playback assertions.",
  );
  return capability;
}

async function startPlaybackIfNeeded(
  page: Page,
  testInfo: TestInfo,
  capability: NativeHlsCapability,
  stage: string,
): Promise<void> {
  const gestureCta = page.getByTestId("gesture-play-cta");
  const visible = await gestureCta.isVisible().catch(() => false);
  if (!visible) {
    return;
  }

  try {
    await gestureCta.scrollIntoViewIfNeeded();
    await expect(gestureCta).toBeVisible({
      timeout: 6_000,
    });
    await expect(gestureCta).toBeEnabled({
      timeout: 6_000,
    });
    await gestureCta.click({
      timeout: 6_000,
    });
  } catch (error) {
    await attachRoomDiagnostics(
      page,
      testInfo,
      stage,
      "Gesture CTA click failed on WebKit playback flow.",
      {
        nativeCapability: capability,
      },
    );
    throw error;
  }
}

async function assertNoDegradedFooter(
  page: Page,
  testInfo: TestInfo,
  capability: NativeHlsCapability,
  stage: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const snapshot = await readRoomVideoDiagnostics(page);
          return snapshot.footerDisplayState === "DEGRADED";
        },
        {
          timeout: STARTUP_TIMEOUT_MS,
          intervals: [250, 500, 1_000],
        },
      )
      .toBe(false);
  } catch (error) {
    await attachRoomDiagnostics(
      page,
      testInfo,
      stage,
      "WebKit playback entered DEGRADED footer state.",
      {
        nativeCapability: capability,
      },
    );
    throw error;
  }
}

async function assertPlaybackNotStuck(
  page: Page,
  testInfo: TestInfo,
  capability: NativeHlsCapability,
  stage: string,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const snapshot = await readRoomVideoDiagnostics(page);
          if (snapshot.currentTime > 0.2) {
            return true;
          }

          const playbackStartState = snapshot.probe?.playbackStartState ?? "IDLE";
          return (
            snapshot.probe?.playIntentActive === true &&
            playbackStartState !== "PRIMING_REQUIRED" &&
            playbackStartState !== "BLOCKED_AUTOPLAY" &&
            playbackStartState !== "DEGRADED"
          );
        },
        {
          timeout: STARTUP_TIMEOUT_MS,
          intervals: [250, 500, 1_000],
        },
      )
      .toBe(true);
  } catch (error) {
    await attachRoomDiagnostics(
      page,
      testInfo,
      stage,
      "WebKit playback stayed stuck without visible progress or active startup state.",
      {
        nativeCapability: capability,
      },
    );
    throw error;
  }
}

async function waitForPlaybackProgress(
  page: Page,
  testInfo: TestInfo,
  capability: NativeHlsCapability,
  stage: string,
): Promise<void> {
  const video = page.getByTestId("hls-video");
  await expect(video).toBeVisible({
    timeout: PLAYBACK_TIMEOUT_MS,
  });

  try {
    await expect
      .poll(
        async () =>
          video.evaluate(
            (element) => (element as HTMLVideoElement).currentTime || 0,
          ),
        {
          timeout: PLAYBACK_TIMEOUT_MS,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toBeGreaterThan(1);
  } catch (error) {
    await attachRoomDiagnostics(
      page,
      testInfo,
      stage,
      "WebKit playback progress gate timed out (expected currentTime > 1).",
      {
        nativeCapability: capability,
      },
    );
    throw error;
  }
}

async function assertShortStabilityProgress(
  page: Page,
  testInfo: TestInfo,
  capability: NativeHlsCapability,
  stage: string,
): Promise<void> {
  const video = page.getByTestId("hls-video");
  const startTime = await video.evaluate(
    (element) => (element as HTMLVideoElement).currentTime || 0,
  );

  await page.waitForTimeout(3_000);

  const endTime = await video.evaluate(
    (element) => (element as HTMLVideoElement).currentTime || 0,
  );

  try {
    expect(endTime - startTime).toBeGreaterThan(0.5);
  } catch (error) {
    await attachRoomDiagnostics(
      page,
      testInfo,
      stage,
      "WebKit playback failed to sustain short stability-window progress.",
      {
        nativeCapability: capability,
        startTime,
        endTime,
      },
    );
    throw error;
  }
}

async function armReloadStabilityMetrics(page: Page): Promise<void> {
  await page.evaluate(() => {
    const media = document.querySelector(
      '[data-testid="hls-video"]',
    ) as HTMLVideoElement | null;
    if (!media) {
      throw new Error("Missing hls video element for WebKit stability probe.");
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
}

async function assertReloadStability(
  page: Page,
  testInfo: TestInfo,
  capability: NativeHlsCapability,
): Promise<void> {
  const video = page.getByTestId("hls-video");
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

  try {
    expect(paused).toBe(false);
    expect(progressDelta).toBeGreaterThanOrEqual(PRIMARY_PROGRESS_DELTA_MIN_SEC);

    if (instabilityCount > WAITING_STALLED_SOFT_LIMIT) {
      expect(progressDelta).toBeGreaterThanOrEqual(SECONDARY_PROGRESS_DELTA_MIN_SEC);
    }
  } catch (error) {
    await attachRoomDiagnostics(
      page,
      testInfo,
      "webkit_reload_stability",
      "WebKit reload stability window did not sustain expected playback progress.",
      {
        nativeCapability: capability,
        progressDelta,
        paused,
        metrics,
      },
    );
    throw error;
  }
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test.describe("Room Playback WebKit", () => {
  test.skip(!INVITE_CODE, "Missing HLS_TEST_INVITE_CODE.");

  test("room playback reaches advancing video time on WebKit when native HLS is available", async ({
    page,
  }, testInfo) => {
    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await completeInviteFlow(page);
    await completeIdentityFlow(page);
    await skipIfRoomNotPlayable(page);

    const capability = await ensureNativeHlsCapability(
      page,
      testInfo,
      "webkit_capability_primary",
    );

    await startPlaybackIfNeeded(page, testInfo, capability, "webkit_gesture_primary");
    await assertNoDegradedFooter(
      page,
      testInfo,
      capability,
      "webkit_footer_primary",
    );
    await assertPlaybackNotStuck(
      page,
      testInfo,
      capability,
      "webkit_startup_primary",
    );
    await waitForPlaybackProgress(
      page,
      testInfo,
      capability,
      "webkit_progress_primary",
    );
    await assertShortStabilityProgress(
      page,
      testInfo,
      capability,
      "webkit_stability_primary",
    );
  });

  test("cookie bypass reload + delayed gesture start remains stable on WebKit when native HLS is available", async ({
    page,
  }, testInfo) => {
    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await completeInviteFlow(page);
    await completeIdentityFlow(page);
    await skipIfRoomNotPlayable(page);

    const capability = await ensureNativeHlsCapability(
      page,
      testInfo,
      "webkit_capability_reload_pre",
    );

    await startPlaybackIfNeeded(page, testInfo, capability, "webkit_gesture_reload_pre");
    await assertNoDegradedFooter(
      page,
      testInfo,
      capability,
      "webkit_footer_reload_pre",
    );
    await waitForPlaybackProgress(
      page,
      testInfo,
      capability,
      "webkit_progress_reload_pre",
    );

    await page.reload({
      waitUntil: "domcontentloaded",
    });
    await completeIdentityFlow(page, {
      optional: true,
    });
    await expect(page.getByTestId("invite-code-input")).toBeHidden({
      timeout: 10_000,
    });

    const video = page.getByTestId("hls-video");
    await expect(video).toBeVisible({
      timeout: PLAYBACK_TIMEOUT_MS,
    });
    await armReloadStabilityMetrics(page);

    await page.waitForTimeout(IDLE_DELAY_MS);

    await startPlaybackIfNeeded(page, testInfo, capability, "webkit_gesture_reload_post");
    await assertNoDegradedFooter(
      page,
      testInfo,
      capability,
      "webkit_footer_reload_post",
    );
    await assertPlaybackNotStuck(
      page,
      testInfo,
      capability,
      "webkit_startup_reload_post",
    );
    await waitForPlaybackProgress(
      page,
      testInfo,
      capability,
      "webkit_progress_reload_post",
    );
    await assertReloadStability(page, testInfo, capability);
  });
});
