import { writeFile } from "node:fs/promises";
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
const GESTURE_RACE_TIMEOUT_MS = Number(
  process.env.HLS_E2E_GESTURE_RACE_TIMEOUT_MS ?? 12_000,
);
const POST_GESTURE_PROOF_TIMEOUT_MS = Number(
  process.env.HLS_E2E_POST_GESTURE_PROOF_TIMEOUT_MS ?? 2_000,
);
const GESTURE_POLL_INTERVAL_MS = Number(
  process.env.HLS_E2E_GESTURE_POLL_INTERVAL_MS ?? 150,
);
const FORCE_GESTURE_CLICK = process.env.HLS_E2E_FORCE_GESTURE_CLICK === "1";
const PRIMARY_PROGRESS_DELTA_MIN_SEC = 4;
const SECONDARY_PROGRESS_DELTA_MIN_SEC = 5;
const WAITING_STALLED_SOFT_LIMIT = 2;
const MANIFEST_SOURCE_PATTERN = /\.m3u8(?:$|[?#])/i;
const STARTUP_PROVEN_STATES = new Set([
  "STARTING",
  "CANONICAL_SEEKED",
  "PLAYING",
  "BUFFERING",
]);

type RuntimeProbeState = {
  playbackEngine?: string;
  manifestParsed?: boolean;
  nativeMetadataLoaded?: boolean;
  readinessStage?: string;
  readyState?: number;
  buffering?: boolean;
  recoveryState?: string;
  playbackStartState?: string;
  autoplayBlocked?: boolean;
  playIntentActive?: boolean;
  operationOwner?: "none" | "startup" | "token_refresh" | "recovery";
  reinitLocked?: boolean;
  pendingReinitReason?: "token_refresh" | "recovery" | null;
  requiresPriming?: boolean;
  isPrimed?: boolean;
  startupAttemptId?: number;
  gestureTapCount?: number;
  lastGestureAtMs?: number | null;
  lastPlayAttempt?: string | null;
  startupCalledFromGesture?: boolean;
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

type GestureBranch = "cta_clicked" | "cta_not_required";
type GestureRaceState = "waiting" | "cta_visible" | "startup_proven_or_progressing";

type GestureContext = {
  branch: GestureBranch;
  forceClickUsed: boolean;
  trialClickError: string | null;
};

type DiagnosticsContext = {
  branch?: GestureBranch;
  forceClickUsed?: boolean;
  trialClickError?: string | null;
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

function isStartupProvenByProbe(probe: RuntimeProbeState | null): boolean {
  if (!probe) {
    return false;
  }
  if (probe.playIntentActive !== true) {
    return false;
  }
  if (
    probe.playbackStartState === "PRIMING_REQUIRED" ||
    probe.playbackStartState === "BLOCKED_AUTOPLAY"
  ) {
    return false;
  }
  return STARTUP_PROVEN_STATES.has(probe.playbackStartState ?? "");
}

function hasAcceptedPlayAttempt(probe: RuntimeProbeState | null): boolean {
  const attempt = probe?.lastPlayAttempt ?? "";
  return attempt === "video_play_ok" || /^video_play_failed:/.test(attempt);
}

function hasGestureAttributedStartup(probe: RuntimeProbeState | null): boolean {
  if (!probe) {
    return false;
  }
  return Boolean(probe.startupCalledFromGesture) && (probe.gestureTapCount ?? 0) >= 1;
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
  context: DiagnosticsContext = {},
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
      context,
      diagnostics,
    },
    AUTH_KEYS,
  );

  const body = JSON.stringify(safePayload, null, 2);

  await testInfo.attach(`room-${stage}-diagnostics`, {
    body,
    contentType: "application/json",
  });
  await writeFile(testInfo.outputPath(`room-${stage}-diagnostics.json`), body, "utf8");
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

async function assertGestureProofAfterClick(
  page: Page,
  testInfo: TestInfo,
  context: GestureContext,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => (await readVideoDiagnostics(page)).probe?.gestureTapCount ?? 0,
        {
          timeout: POST_GESTURE_PROOF_TIMEOUT_MS,
          intervals: [GESTURE_POLL_INTERVAL_MS],
          message: "Gesture proof failed: expected gestureTapCount >= 1 after click.",
        },
      )
      .toBeGreaterThanOrEqual(1);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "gesture_proof_tap",
      "Gesture CTA click did not increment gestureTapCount.",
      context,
    );
    throw error;
  }

  try {
    await expect
      .poll(
        async () => {
          const probe = (await readVideoDiagnostics(page)).probe;
          return hasAcceptedPlayAttempt(probe) || hasGestureAttributedStartup(probe);
        },
        {
          timeout: POST_GESTURE_PROOF_TIMEOUT_MS,
          intervals: [GESTURE_POLL_INTERVAL_MS],
          message:
            "Gesture proof failed: expected accepted play attempt or startupCalledFromGesture.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "gesture_proof_milestone",
      "Gesture CTA click did not advance play milestone.",
      context,
    );
    throw error;
  }
}

async function performGestureHandshake(
  page: Page,
  testInfo: TestInfo,
): Promise<GestureContext> {
  const gestureCta = page.getByTestId("gesture-play-cta");
  let raceOutcome: GestureRaceState = "waiting";

  try {
    await expect
      .poll(
        async () => {
          const [ctaVisible, snapshot] = await Promise.all([
            gestureCta.isVisible().catch(() => false),
            readVideoDiagnostics(page),
          ]);
          if (ctaVisible) {
            raceOutcome = "cta_visible";
            return raceOutcome;
          }
          if (
            snapshot.currentTime > 0.2 ||
            isStartupProvenByProbe(snapshot.probe)
          ) {
            raceOutcome = "startup_proven_or_progressing";
            return raceOutcome;
          }
          raceOutcome = "waiting";
          return raceOutcome;
        },
        {
          timeout: GESTURE_RACE_TIMEOUT_MS,
          intervals: [GESTURE_POLL_INTERVAL_MS],
          message:
            "Gesture race timed out: expected CTA visibility or startup/progress proof.",
        },
      )
      .not.toBe("waiting");
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "gesture_race",
      "Gesture race timed out before CTA/progress branch selection.",
    );
    throw error;
  }

  if (raceOutcome === "startup_proven_or_progressing") {
    return {
      branch: "cta_not_required",
      forceClickUsed: false,
      trialClickError: null,
    };
  }

  const context: GestureContext = {
    branch: "cta_clicked",
    forceClickUsed: false,
    trialClickError: null,
  };

  await gestureCta.scrollIntoViewIfNeeded();
  await expect(gestureCta).toBeVisible({
    timeout: 6_000,
  });
  await expect(gestureCta).toBeEnabled({
    timeout: 6_000,
  });

  try {
    await gestureCta.click({
      trial: true,
      timeout: 6_000,
    });
  } catch (error) {
    context.trialClickError = error instanceof Error ? error.message : String(error);
    await attachDiagnostics(
      page,
      testInfo,
      "gesture_trial_click",
      "Gesture CTA trial click failed; element may be covered.",
      context,
    );
    throw error;
  }

  try {
    await gestureCta.click({
      timeout: 6_000,
    });
  } catch (error) {
    if (!FORCE_GESTURE_CLICK) {
      await attachDiagnostics(
        page,
        testInfo,
        "gesture_click",
        `Gesture CTA click failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        context,
      );
      throw error;
    }

    context.forceClickUsed = true;
    // Keep forced click strictly diagnostic and easy to detect in logs.
    console.warn(
      "WARNING: HLS_E2E_FORCE_GESTURE_CLICK=1 enabled; applying force click fallback.",
    );
    await gestureCta.click({
      timeout: 6_000,
      force: true,
    });
  }

  await assertGestureProofAfterClick(page, testInfo, context);
  return context;
}

async function waitForPlaybackProgress(
  page: Page,
  testInfo: TestInfo,
  stage: string,
  context: GestureContext,
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
      context,
    );
    throw error;
  }
}

async function assertChromiumEnginePath(
  page: Page,
  browserName: string,
  testInfo: TestInfo,
  context?: GestureContext,
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
      context,
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
      context,
    );
    throw error;
  }
}

async function assertPlaybackNotStuck(
  page: Page,
  testInfo: TestInfo,
  context: GestureContext,
): Promise<void> {
  const video = page.getByTestId("hls-video");
  await expect(video).toBeVisible({ timeout: 45_000 });

  try {
    await expect
      .poll(
        async () => {
          const snapshot = await readVideoDiagnostics(page);
          if (snapshot.currentTime > 0.2) {
            return true;
          }

          if (context.branch === "cta_not_required") {
            return isStartupProvenByProbe(snapshot.probe);
          }

          const probe = snapshot.probe;
          const gestureTapCount = probe?.gestureTapCount ?? 0;
          const startupState = probe?.playbackStartState ?? "IDLE";
          const hasAcceptedMilestone =
            probe?.lastPlayAttempt === "video_play_ok" ||
            hasGestureAttributedStartup(probe);
          const startupStateAllowsExit =
            startupState !== "PRIMING_REQUIRED" &&
            startupState !== "BLOCKED_AUTOPLAY";

          return (
            gestureTapCount >= 1 &&
            hasAcceptedMilestone &&
            startupStateAllowsExit
          );
        },
        {
          timeout: STARTUP_PRE_GATE_TIMEOUT_MS,
          intervals: [250, 500, 1_000],
          message:
            "Startup stuck: expected currentTime>0.2 or strict branch-aware startup proof.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "startup_not_stuck",
      "Startup readiness pre-gate timed out.",
      context,
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

    const gestureContext = await performGestureHandshake(page, testInfo);
    await assertChromiumEnginePath(page, browserName, testInfo, gestureContext);
    await assertPlaybackNotStuck(page, testInfo, gestureContext);
    await waitForPlaybackProgress(
      page,
      testInfo,
      "playback_progress_primary",
      gestureContext,
    );
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

    const firstGestureContext = await performGestureHandshake(page, testInfo);
    await assertChromiumEnginePath(page, browserName, testInfo, firstGestureContext);
    await waitForPlaybackProgress(
      page,
      testInfo,
      "playback_progress_pre_reload",
      firstGestureContext,
    );

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

    const secondGestureContext = await performGestureHandshake(page, testInfo);
    await assertChromiumEnginePath(page, browserName, testInfo, secondGestureContext);
    await assertPlaybackNotStuck(page, testInfo, secondGestureContext);
    await waitForPlaybackProgress(
      page,
      testInfo,
      "playback_progress_post_reload",
      secondGestureContext,
    );

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
