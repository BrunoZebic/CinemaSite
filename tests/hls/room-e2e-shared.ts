import { writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { NATIVE_HLS_MIME_TYPES } from "../../lib/video/hlsEngineSelection";
import { loadLocalEnv } from "../../scripts/hls/env";
import { buildAuthKeySet, redactUnknown } from "../../scripts/hls/redact";

loadLocalEnv();

export const AUTH_KEYS = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
export const ROOM =
  process.env.HLS_TEST_ROOM?.trim() ?? process.env.HLS_E2E_ROOM?.trim() ?? "demo";
export const BASE_URL =
  process.env.HLS_TEST_BASE_URL?.trim() ??
  process.env.HLS_E2E_BASE_URL?.trim() ??
  "http://localhost:3100";
export const INVITE_CODE =
  process.env.HLS_TEST_INVITE_CODE?.trim() ??
  process.env.HLS_E2E_INVITE_CODE?.trim() ??
  "";
const OPTIONAL_IDENTITY_TIMEOUT_MS = 1_000;
const OPTIONAL_IDENTITY_POLL_INTERVALS_MS = [200, 200, 200, 200, 200];

export type RuntimeProbeState = {
  playbackEngine?: string;
  manifestParsed?: boolean;
  nativeMetadataLoaded?: boolean;
  nativeCanPlayHls?: boolean;
  nativeHlsMimeType?: string | null;
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
};

export type VideoDiagnostics = {
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
};

export type NativeHlsCapability = {
  nativeCanPlayHls: boolean;
  nativeHlsMimeType: string | null;
  supportByMimeType: Record<string, string>;
  userAgent: string;
  viewport: {
    width: number;
    height: number;
  };
};

export function roomUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/premiere/${encodeURIComponent(ROOM)}`;
}

export async function readRoomVideoDiagnostics(
  page: Page,
): Promise<VideoDiagnostics> {
  return page.evaluate(() => {
    const media = document.querySelector(
      '[data-testid="hls-video"]',
    ) as HTMLVideoElement | null;

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
    };
  });
}

export async function attachRoomDiagnostics(
  page: Page,
  testInfo: TestInfo,
  stage: string,
  reason: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const diagnostics = await readRoomVideoDiagnostics(page).catch(() => ({
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

export async function completeInviteFlow(page: Page): Promise<void> {
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

export async function completeIdentityFlow(
  page: Page,
  options?: {
    nickname?: string;
    optional?: boolean;
  },
): Promise<boolean> {
  const nickname = options?.nickname ?? "Week4Tester";
  const optional = options?.optional ?? false;
  const identityInput = page.getByTestId("identity-nickname-input");

  if (optional) {
    const becameVisible = await expect
      .poll(async () => identityInput.isVisible().catch(() => false), {
        timeout: OPTIONAL_IDENTITY_TIMEOUT_MS,
        intervals: OPTIONAL_IDENTITY_POLL_INTERVALS_MS,
      })
      .toBe(true)
      .then(
        () => true,
        () => false,
      );

    if (!becameVisible) {
      return false;
    }

    await identityInput.fill(nickname);
    await page.getByTestId("identity-submit").click();
    await expect(identityInput).toBeHidden({
      timeout: 10_000,
    });
    return true;
  }

  await expect(identityInput).toBeVisible({
    timeout: 20_000,
  });
  await identityInput.fill(nickname);
  await page.getByTestId("identity-submit").click();
  await expect(identityInput).toBeHidden({
    timeout: 10_000,
  });
  return true;
}

export async function skipIfRoomNotPlayable(page: Page): Promise<void> {
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

export async function readNativeHlsCapability(
  page: Page,
): Promise<NativeHlsCapability> {
  return page.evaluate((mimeTypes) => {
    const video = document.createElement("video");
    const supportByMimeType: Record<string, string> = {};
    let nativeHlsMimeType: string | null = null;

    for (const mimeType of mimeTypes) {
      const support = video.canPlayType(mimeType);
      supportByMimeType[mimeType] = support;
      if (nativeHlsMimeType === null && support.trim() !== "") {
        nativeHlsMimeType = mimeType;
      }
    }

    return {
      nativeCanPlayHls: nativeHlsMimeType !== null,
      nativeHlsMimeType,
      supportByMimeType,
      userAgent: navigator.userAgent,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    };
  }, [...NATIVE_HLS_MIME_TYPES]);
}
