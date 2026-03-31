import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { buildAuthKeySet, redactUnknown } from "../../scripts/hls/redact";
import { loadHarnessContext } from "../../scripts/hls/context";
import {
  captureGestureProofBaseline,
  evaluateGestureProofAfterClick,
  hasNonAttributionStartupOutcome,
  isStartupProvenByProbe,
  type GestureProofBaseline,
  type GestureProofEvaluation,
} from "./room-gesture-proof";

const { room: ROOM, baseUrl: BASE_URL, inviteCode: INVITE_CODE } = loadHarnessContext();
const AUTH_KEYS = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
const IDLE_DELAY_MS = Number(process.env.HLS_E2E_IDLE_DELAY_MS ?? 10_000);
const STABILITY_WINDOW_MS = Number(process.env.HLS_E2E_STABILITY_WINDOW_MS ?? 10_000);
const STARTUP_PRE_GATE_TIMEOUT_MS = Number(
  process.env.HLS_E2E_STARTUP_PRE_GATE_TIMEOUT_MS ?? 12_000,
);
const GESTURE_RACE_TIMEOUT_MS = Number(
  process.env.HLS_E2E_GESTURE_RACE_TIMEOUT_MS ?? 12_000,
);
const FAIL_ON_NON_PLAYABLE_ROOM = process.env.HLS_E2E_FAIL_ON_NON_PLAYABLE_ROOM === "1";
const POST_GESTURE_PROOF_TIMEOUT_MS = Number(
  process.env.HLS_E2E_POST_GESTURE_PROOF_TIMEOUT_MS ?? 4_000,
);
const GESTURE_POLL_INTERVAL_MS = Number(
  process.env.HLS_E2E_GESTURE_POLL_INTERVAL_MS ?? 150,
);
const FORCE_GESTURE_CLICK = process.env.HLS_E2E_FORCE_GESTURE_CLICK === "1";
const ATTACH_ADVISORIES = process.env.HLS_E2E_ATTACH_ADVISORIES === "1";
const PRIMARY_PROGRESS_DELTA_MIN_SEC = 4;
const SECONDARY_PROGRESS_DELTA_MIN_SEC = 5;
const WAITING_STALLED_SOFT_LIMIT = 2;
const MANIFEST_SOURCE_PATTERN = /\.m3u8(?:$|[?#])/i;
const FOOTER_TRANSIENT_TEXT_MARKERS: Record<
  "STARTING" | "SYNCING" | "BUFFERING",
  string
> = {
  STARTING: "Starting",
  SYNCING: "Syncing",
  BUFFERING: "Buffering",
};

type FooterDisplayState =
  | "SILENCE"
  | "DEGRADED"
  | "PRIMING_REQUIRED"
  | "AUTOPLAY_BLOCKED"
  | "WAITING_PRIMED"
  | "STARTING"
  | "SYNCING"
  | "BUFFERING"
  | "PLAYING"
  | "LOADING";

const FOOTER_TEXT_BY_STATE: Record<FooterDisplayState, string> = {
  SILENCE: "Silence interval in progress.",
  DEGRADED: "Playback issue - Retry",
  PRIMING_REQUIRED: "Tap to enable playback.",
  AUTOPLAY_BLOCKED: "Tap to play.",
  WAITING_PRIMED: "Playback primed. Waiting for start.",
  STARTING: "Starting...",
  SYNCING: "Syncing...",
  BUFFERING: "Buffering stream...",
  PLAYING: "Live playback synchronized.",
  LOADING: "Loading stream...",
};

const FOOTER_EXACT_MATCH_STATES = new Set<FooterDisplayState>([
  "PRIMING_REQUIRED",
  "AUTOPLAY_BLOCKED",
  "PLAYING",
  "DEGRADED",
  "WAITING_PRIMED",
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
  primedForMountId?: number | null;
  startupAttemptId?: number;
  gestureTapCount?: number;
  overlayTapHandledCount?: number;
  lastGestureAtMs?: number | null;
  lastPlayAttempt?: string | null;
  startupCalledFromGesture?: boolean;
  hlsInstanceId?: number;
  attachCount?: number;
  detachCount?: number;
  srcSetCount?: number;
  loadCalledCount?: number;
  videoElementMountId?: number;
  videoRefAssignedAtMs?: number | null;
  pauseCount?: number;
  lastPauseReason?: string | null;
  startupRunStartedCount?: number;
  startupRunAbortedCount?: number;
  startupWindowRunId?: number | null;
  startupWindowStartAtMs?: number | null;
  startupWindowEndAtMs?: number | null;
  runEndedReason?:
    | "progress_reached"
    | "play_failed"
    | "handoff_to_recovery"
    | "aborted_by_supersession"
    | "aborted_other"
    | null;
  lastAbortCause?: string | null;
  startupSuppressedReason?: "priming_required" | "already_active_run" | null;
  playAttemptRunId?: number | null;
  playAttemptStartAtMs?: number | null;
  doubleStartSuspected?: boolean;
  suppressedThenTappedSuspected?: boolean;
  hasSubtitleTrack?: boolean;
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
  footerText: string;
  footerDisplayState: string | null;
  playerFullscreen: string | null;
  screenVisualState: string | null;
  playerPhaseVisualState: string | null;
  playerTransitionKind: string | null;
  fullscreenElementTestId: string | null;
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
  gestureProofBaseline?: GestureProofBaseline;
  gestureProofEvaluation?: GestureProofEvaluation;
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

function parseFooterDisplayState(value: string | null): FooterDisplayState | null {
  if (!value) {
    return null;
  }
  return value in FOOTER_TEXT_BY_STATE ? (value as FooterDisplayState) : null;
}

function expectedFooterStateFromProbe(
  probe: RuntimeProbeState | null,
): FooterDisplayState | null {
  if (!probe) {
    return null;
  }
  if (probe.recoveryState === "DEGRADED") {
    return "DEGRADED";
  }
  if (probe.playbackStartState === "PRIMING_REQUIRED") {
    return "PRIMING_REQUIRED";
  }
  if (probe.playbackStartState === "BLOCKED_AUTOPLAY") {
    return "AUTOPLAY_BLOCKED";
  }
  if (probe.playbackStartState === "STARTING") {
    return "STARTING";
  }
  if (probe.playbackStartState === "CANONICAL_SEEKED") {
    return "SYNCING";
  }
  if (probe.playbackStartState === "BUFFERING") {
    return "BUFFERING";
  }
  if (probe.playbackStartState === "PLAYING") {
    return "PLAYING";
  }
  if (
    probe.playbackStartState === "IDLE" &&
    probe.isPrimed === true &&
    probe.playIntentActive !== true
  ) {
    return "WAITING_PRIMED";
  }
  return null;
}

function shouldBanLegacyNotReadyText(probe: RuntimeProbeState | null): boolean {
  if (!probe) {
    return false;
  }
  if (typeof probe.startupWindowRunId === "number") {
    return true;
  }
  if (typeof probe.playbackStartState === "string" && probe.playbackStartState !== "IDLE") {
    return true;
  }
  return probe.runEndedReason !== null && probe.runEndedReason !== undefined;
}

async function readVideoDiagnostics(page: Page): Promise<VideoDiagnostics> {
  return page.evaluate(() => {
    const media = document.querySelector(
      '[data-testid="hls-video"]',
    ) as HTMLVideoElement | null;
    const playerShell = document.querySelector(
      '[data-testid="player-presentation-shell"]',
    ) as HTMLElement | null;
    const fullscreenElement = document.fullscreenElement as HTMLElement | null;

    const probe = (window as unknown as { __HLS_E2E_PROBE__?: RuntimeProbeState })
      .__HLS_E2E_PROBE__;
    const footer = document.querySelector(
      '[data-testid="video-status-note"]',
    ) as HTMLElement | null;
    const footerText = footer?.textContent?.trim() ?? "";
    const footerDisplayState = footer?.getAttribute("data-footer-display-state") ?? null;

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
        footerText,
        footerDisplayState,
        playerFullscreen: playerShell?.getAttribute("data-player-fullscreen") ?? null,
        screenVisualState: playerShell?.getAttribute("data-screen-visual-state") ?? null,
        playerPhaseVisualState:
          playerShell?.getAttribute("data-player-phase-visual-state") ?? null,
        playerTransitionKind:
          playerShell?.getAttribute("data-player-transition-kind") ?? null,
        fullscreenElementTestId: fullscreenElement?.getAttribute("data-testid") ?? null,
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
      footerText,
      footerDisplayState,
      playerFullscreen: playerShell?.getAttribute("data-player-fullscreen") ?? null,
      screenVisualState: playerShell?.getAttribute("data-screen-visual-state") ?? null,
      playerPhaseVisualState:
        playerShell?.getAttribute("data-player-phase-visual-state") ?? null,
      playerTransitionKind:
        playerShell?.getAttribute("data-player-transition-kind") ?? null,
      fullscreenElementTestId: fullscreenElement?.getAttribute("data-testid") ?? null,
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
    footerText: "",
    footerDisplayState: null,
    playerFullscreen: null,
    screenVisualState: null,
    playerPhaseVisualState: null,
    playerTransitionKind: null,
    fullscreenElementTestId: null,
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

async function maybeAttachGestureProofAdvisory(
  page: Page,
  testInfo: TestInfo,
  stage: string,
  reason: string,
  context: GestureContext,
  baseline: GestureProofBaseline,
  evaluation: GestureProofEvaluation,
): Promise<void> {
  if (!ATTACH_ADVISORIES) {
    return;
  }

  await attachDiagnostics(page, testInfo, stage, reason, {
    ...context,
    gestureProofBaseline: baseline,
    gestureProofEvaluation: evaluation,
  });
}

async function assertGestureProofAfterClick(
  page: Page,
  testInfo: TestInfo,
  context: GestureContext,
  baseline: GestureProofBaseline,
): Promise<void> {
  let latestEvaluation: GestureProofEvaluation | undefined;

  try {
    await expect
      .poll(
        async () => {
          const snapshot = await readVideoDiagnostics(page);
          latestEvaluation = evaluateGestureProofAfterClick(baseline, snapshot);
          return latestEvaluation.pass;
        },
        {
          timeout: POST_GESTURE_PROOF_TIMEOUT_MS,
          intervals: [GESTURE_POLL_INTERVAL_MS],
          message:
            "Gesture proof failed: expected overlayTapHandledCount delta and post-click startup outcome evidence.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "gesture_proof_milestone",
      "Gesture CTA click did not produce post-click startup outcome evidence.",
      {
        ...context,
        gestureProofBaseline: baseline,
        gestureProofEvaluation: latestEvaluation ?? undefined,
      },
    );
    throw error;
  }

  const postProofSnapshot = await readVideoDiagnostics(page);
  const advisoryEvaluation = evaluateGestureProofAfterClick(
    baseline,
    postProofSnapshot,
  );

  if (advisoryEvaluation.usedPreProvenAdvisoryPath) {
    await maybeAttachGestureProofAdvisory(
      page,
      testInfo,
      "gesture_proof_preproven_advisory",
      "Gesture CTA proof passed on pre-proven startup race-safe advisory path.",
      context,
      baseline,
      advisoryEvaluation,
    );
  }

  if (advisoryEvaluation.attributionMissing) {
    await maybeAttachGestureProofAdvisory(
      page,
      testInfo,
      "gesture_proof_attribution_advisory",
      "Gesture CTA proof passed without startupCalledFromGesture attribution signal.",
      context,
      baseline,
      advisoryEvaluation,
    );
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

  if (raceOutcome === "waiting") {
    await attachDiagnostics(
      page,
      testInfo,
      "gesture_race_invariant",
      "Gesture race invariant violated: poll completed but raceOutcome remained waiting.",
    );
    throw new Error(
      "Gesture race invariant violated: expected cta_visible or startup_proven_or_progressing.",
    );
  }

  const resolvedRaceOutcome: Exclude<GestureRaceState, "waiting"> = raceOutcome;
  switch (resolvedRaceOutcome) {
    case "startup_proven_or_progressing":
      return {
        branch: "cta_not_required",
        forceClickUsed: false,
        trialClickError: null,
      };
    case "cta_visible":
      break;
    default: {
      const unexpectedOutcome: never = resolvedRaceOutcome;
      throw new Error(
        `Unexpected resolved gesture race outcome: ${String(unexpectedOutcome)}`,
      );
    }
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

  const baselineSnapshot = await readVideoDiagnostics(page);
  const gestureProofBaseline = captureGestureProofBaseline(
    baselineSnapshot,
    isStartupProvenByProbe(baselineSnapshot.probe),
  );

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

  await assertGestureProofAfterClick(page, testInfo, context, gestureProofBaseline);
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
          const hasStartupOutcome = hasNonAttributionStartupOutcome(snapshot);
          const startupStateAllowsExit =
            startupState !== "PRIMING_REQUIRED" &&
            startupState !== "BLOCKED_AUTOPLAY";

          return (
            gestureTapCount >= 1 &&
            hasStartupOutcome &&
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

async function assertNoSuppressionPriorityRegression(
  page: Page,
  testInfo: TestInfo,
  context: GestureContext,
): Promise<void> {
  const probe = (await readVideoDiagnostics(page)).probe;
  if (!probe?.suppressedThenTappedSuspected) {
    return;
  }
  await attachDiagnostics(
    page,
    testInfo,
    "suppression_priority_regression",
    "Detected suppressedThenTappedSuspected=true; gesture tap appears suppressed by already_active_run.",
    context,
  );
  throw new Error(
    "suppressedThenTappedSuspected=true indicates gesture startup was incorrectly suppressed as already-active.",
  );
}

async function assertFooterAlignedWithProbe(
  page: Page,
  testInfo: TestInfo,
  stage: string,
  context: GestureContext,
): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          const snapshot = await readVideoDiagnostics(page);
          const footerText = snapshot.footerText;
          const footerDisplayState = parseFooterDisplayState(
            snapshot.footerDisplayState,
          );
          const expectedState = expectedFooterStateFromProbe(snapshot.probe);

          if (footerText.toLowerCase().includes("sync idle")) {
            return false;
          }

          if (expectedState && footerDisplayState !== expectedState) {
            return false;
          }

          if (expectedState) {
            const expectedText = FOOTER_TEXT_BY_STATE[expectedState];
            if (FOOTER_EXACT_MATCH_STATES.has(expectedState)) {
              if (footerText !== expectedText) {
                return false;
              }
            } else {
              const marker =
                expectedState === "STARTING" ||
                expectedState === "SYNCING" ||
                expectedState === "BUFFERING"
                  ? FOOTER_TRANSIENT_TEXT_MARKERS[expectedState]
                  : expectedText;
              if (!footerText.includes(marker)) {
                return false;
              }
            }
          }

          if (
            shouldBanLegacyNotReadyText(snapshot.probe) &&
            footerText.includes("Player is not ready yet.")
          ) {
            return false;
          }

          return true;
        },
        {
          timeout: STARTUP_PRE_GATE_TIMEOUT_MS,
          intervals: [GESTURE_POLL_INTERVAL_MS],
          message:
            "Footer status did not align with probe/coordinator state in expected window.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      stage,
      "Footer status line was not aligned with playback/probe state.",
      context,
    );
    throw error;
  }
}

async function skipIfRoomNotPlayable(page: Page): Promise<void> {
  const phase = await page
    .getByTestId("phase-badge")
    .getAttribute("data-phase")
    .catch(() => null);
  const roomNotPlayable = phase === "DISCUSSION" || phase === "CLOSED";
  const message = `Room "${ROOM}" is not in a playable phase (WAITING/LIVE required).`;

  if (roomNotPlayable && FAIL_ON_NON_PLAYABLE_ROOM) {
    throw new Error(message);
  }

  test.skip(roomNotPlayable, message);
}

async function revealDesktopPlayerChrome(page: Page): Promise<void> {
  const playerShell = page.getByTestId("player-presentation-shell");
  await playerShell.evaluate((element) => {
    const dispatchPointerEvent = (type: string) => {
      element.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          composed: true,
          pointerType: "mouse",
          isPrimary: true,
        }),
      );
    };

    dispatchPointerEvent("pointerenter");
    dispatchPointerEvent("pointermove");
    dispatchPointerEvent("pointerdown");
  });
  await expect(playerShell).toHaveAttribute("data-player-chrome-visible", "true", {
    timeout: 10_000,
  });
}

async function assertPlayerFullscreenToggle(
  page: Page,
  testInfo: TestInfo,
  context: GestureContext,
  browserName: string,
): Promise<void> {
  if (browserName !== "chromium") {
    return;
  }

  const playerShell = page.getByTestId("player-presentation-shell");
  await revealDesktopPlayerChrome(page);
  const fullscreenToggle = page.getByTestId("fullscreen-toggle");
  await expect(fullscreenToggle).toBeVisible({
    timeout: 10_000,
  });

  try {
    await expect(playerShell).toHaveAttribute(
      "data-player-fullscreen",
      "false",
      {
        timeout: 5_000,
      },
    );

    await fullscreenToggle.click({
      timeout: 6_000,
      force: true,
    });

    await expect
      .poll(
        async () => {
          const snapshot = await readVideoDiagnostics(page);
          return (
            snapshot.playerFullscreen === "true" &&
            snapshot.fullscreenElementTestId === "player-presentation-shell" &&
            snapshot.playerPhaseVisualState !== null &&
            snapshot.playerTransitionKind !== null
          );
        },
        {
          timeout: 8_000,
          intervals: [100, 250, 500],
          message:
            "Expected fullscreen toggle to promote the player presentation shell into fullscreen.",
        },
      )
      .toBe(true);

    await revealDesktopPlayerChrome(page);
    await fullscreenToggle.click({
      timeout: 6_000,
      force: true,
    });

    await expect
      .poll(
        async () => {
          const snapshot = await readVideoDiagnostics(page);
          return (
            snapshot.playerFullscreen === "false" &&
            snapshot.fullscreenElementTestId === null &&
            snapshot.playerPhaseVisualState !== null &&
            snapshot.playerTransitionKind !== null
          );
        },
        {
          timeout: 8_000,
          intervals: [100, 250, 500],
          message:
            "Expected fullscreen toggle to restore the non-fullscreen player presentation shell.",
        },
      )
      .toBe(true);
  } catch (error) {
    await attachDiagnostics(
      page,
      testInfo,
      "fullscreen_toggle",
      "Player fullscreen toggle did not enter/exit fullscreen as expected.",
      context,
    );
    throw error;
  }
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
    await assertFooterAlignedWithProbe(
      page,
      testInfo,
      "footer_align_after_handshake_primary",
      gestureContext,
    );
    await assertChromiumEnginePath(page, browserName, testInfo, gestureContext);
    await assertPlaybackNotStuck(page, testInfo, gestureContext);
    await waitForPlaybackProgress(
      page,
      testInfo,
      "playback_progress_primary",
      gestureContext,
    );
    await assertPlayerFullscreenToggle(page, testInfo, gestureContext, browserName);
    await assertFooterAlignedWithProbe(
      page,
      testInfo,
      "footer_align_after_progress_primary",
      gestureContext,
    );
    await assertNoSuppressionPriorityRegression(page, testInfo, gestureContext);
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
    await assertFooterAlignedWithProbe(
      page,
      testInfo,
      "footer_align_after_handshake_pre_reload",
      firstGestureContext,
    );
    await assertChromiumEnginePath(page, browserName, testInfo, firstGestureContext);
    await waitForPlaybackProgress(
      page,
      testInfo,
      "playback_progress_pre_reload",
      firstGestureContext,
    );
    await assertFooterAlignedWithProbe(
      page,
      testInfo,
      "footer_align_after_progress_pre_reload",
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
    await assertFooterAlignedWithProbe(
      page,
      testInfo,
      "footer_align_after_handshake_post_reload",
      secondGestureContext,
    );
    await assertChromiumEnginePath(page, browserName, testInfo, secondGestureContext);
    await assertPlaybackNotStuck(page, testInfo, secondGestureContext);
    await waitForPlaybackProgress(
      page,
      testInfo,
      "playback_progress_post_reload",
      secondGestureContext,
    );
    await assertFooterAlignedWithProbe(
      page,
      testInfo,
      "footer_align_after_progress_post_reload",
      secondGestureContext,
    );
    await assertNoSuppressionPriorityRegression(page, testInfo, secondGestureContext);

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

// ---------------------------------------------------------------------------
// Subtitle toggle tests — requires a subtitle-enabled room
// ---------------------------------------------------------------------------

const SUBTITLE_ROOM =
  process.env.HLS_TEST_SUBTITLE_ROOM?.trim() ?? "";
const SUBTITLE_INVITE_CODE =
  process.env.HLS_TEST_SUBTITLE_INVITE_CODE?.trim() ?? "";

function subtitleRoomUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/premiere/${encodeURIComponent(SUBTITLE_ROOM)}`;
}

async function completeInviteFlowWithCode(page: Page, code: string): Promise<void> {
  const inviteInput = page.getByTestId("invite-code-input");
  await expect(inviteInput).toBeVisible({ timeout: 20_000 });
  await inviteInput.fill(code);
  await page.getByTestId("invite-submit").click();
  await expect(inviteInput).toBeHidden({ timeout: 20_000 });
}

async function skipIfSubtitleRoomNotPlayable(page: Page): Promise<void> {
  const phase = await page
    .getByTestId("phase-badge")
    .getAttribute("data-phase")
    .catch(() => null);
  test.skip(
    phase === "DISCUSSION" || phase === "CLOSED",
    `Subtitle room "${SUBTITLE_ROOM}" is not in a playable phase (WAITING/LIVE required).`,
  );
}

test.describe("Subtitle Toggle", () => {
  test.skip(!SUBTITLE_ROOM, "Missing HLS_TEST_SUBTITLE_ROOM.");
  test.skip(!SUBTITLE_INVITE_CODE, "Missing HLS_TEST_SUBTITLE_INVITE_CODE.");

  test("subtitle track detected, CC button visible and toggleable", async (
    { page },
    testInfo,
  ) => {
    await page.goto(subtitleRoomUrl(), { waitUntil: "domcontentloaded" });
    await completeInviteFlowWithCode(page, SUBTITLE_INVITE_CODE);
    await maybeHandleIdentityModal(page);
    await skipIfSubtitleRoomNotPlayable(page);

    const gestureContext = await performGestureHandshake(page, testInfo);
    await assertPlaybackNotStuck(
      page,
      testInfo,
      "subtitle_playback_not_stuck",
      gestureContext,
    );
    await waitForPlaybackProgress(
      page,
      testInfo,
      "subtitle_playback_progress",
      gestureContext,
    );

    // Wait until the adapter has resolved the English subtitle track
    await expect
      .poll(
        async () => {
          const diag = await readVideoDiagnostics(page);
          return diag.probe?.hasSubtitleTrack ?? false;
        },
        {
          timeout: STARTUP_PRE_GATE_TIMEOUT_MS,
          intervals: [GESTURE_POLL_INTERVAL_MS],
          message: "Expected hasSubtitleTrack=true in probe after manifest parsed.",
        },
      )
      .toBe(true);

    // CC button must be visible and default ON
    await revealDesktopPlayerChrome(page);
    const ccButton = page.getByTestId("subtitle-toggle");
    await expect(ccButton).toBeVisible();
    await expect(ccButton).toHaveAttribute("aria-pressed", "true");

    // Toggle off
    await ccButton.click({
      force: true,
    });
    await expect(ccButton).toHaveAttribute("aria-pressed", "false");

    // Toggle back on
    await ccButton.click({
      force: true,
    });
    await expect(ccButton).toHaveAttribute("aria-pressed", "true");

    void gestureContext; // consumed
  });
});
