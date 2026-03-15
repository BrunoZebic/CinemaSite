import { writeFile } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { loadLocalEnv } from "../../scripts/hls/env";
import { buildAuthKeySet, redactUnknown } from "../../scripts/hls/redact";
import { getCiRoomConfig, resetCiRoomStart, type CiRoomConfig } from "../../scripts/hls/ciRoomHelper";

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
const WAITING_TO_LIVE_OFFSET_SEC = 60;
const SILENCE_LEAD_SEC = 45;
const CLEANUP_WAITING_OFFSET_SEC = 120;
const MIN_FILM_DURATION_SEC = 60;
const PHASE_TRANSITION_TIMEOUT_MS = 95_000;
const UI_BRANCH_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const IDENTITY_STORAGE_KEY = "premiere.identity.v1";
const PHASE_IDENTITY = {
  nickname: "PhaseTester",
  avatarSeed: "phase-e2e-seed",
  createdAt: 1700000000000,
};
const PHASE_SIGNATURE = "phasetester::phase-e2e-seed";

type PhaseProbeState = {
  playbackStartState?: string;
  isPrimed?: boolean;
};

type PhaseUiSnapshot = {
  phase: string | null;
  countdownLabel: string | null;
  chatOpen: string | null;
  chatPhase: string | null;
  waitingLobbyVisible: boolean;
  silenceBlackoutVisible: boolean;
  gestureVisible: boolean;
  recoveryRetryVisible: boolean;
  subtitleToggleVisible: boolean;
  footerDisplayState: string | null;
  footerText: string;
  composerDisabled: boolean;
  inviteVisible: boolean;
  identityVisible: boolean;
  probe: PhaseProbeState | null;
};

type WaitingBranch = "gesture_required" | "gesture_not_required";
type LiveEntryBranch = "gesture_required" | "gesture_not_required";

function roomUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/premiere/${encodeURIComponent(ROOM)}`;
}

function roomAccessUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/api/rooms/${encodeURIComponent(ROOM)}/access`;
}

function roomMessagesUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/api/rooms/${encodeURIComponent(ROOM)}/messages`;
}

async function seedIdentityBeforeNavigation(page: Page): Promise<void> {
  await page.addInitScript(
    ({ storageKey, identity }) => {
      window.localStorage.removeItem(storageKey);
      window.localStorage.setItem(storageKey, JSON.stringify(identity));
    },
    {
      storageKey: IDENTITY_STORAGE_KEY,
      identity: PHASE_IDENTITY,
    },
  );
}

async function grantInviteAccess(context: BrowserContext): Promise<void> {
  const response = await context.request.post(roomAccessUrl(), {
    data: {
      inviteCode: INVITE_CODE,
    },
  });

  if (!response.ok()) {
    const payload = await response.text().catch(() => "");
    throw new Error(
      `Failed to obtain invite access for room "${ROOM}" (status ${response.status()}): ${payload}`,
    );
  }
}

async function openPhaseRoom(page: Page, context: BrowserContext): Promise<void> {
  await seedIdentityBeforeNavigation(page);
  await grantInviteAccess(context);
  await page.goto(roomUrl(), {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("phase-badge")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId("invite-code-input")).toBeHidden({
    timeout: 10_000,
  });
  await expect(page.getByTestId("identity-nickname-input")).toBeHidden({
    timeout: 10_000,
  });
}

async function readPhaseUiSnapshot(page: Page): Promise<PhaseUiSnapshot> {
  return page.evaluate(() => {
    function isVisible(element: Element | null): boolean {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      const styles = window.getComputedStyle(element);
      if (styles.display === "none" || styles.visibility === "hidden") {
        return false;
      }

      return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    }

    const phaseBadge = document.querySelector('[data-testid="phase-badge"]');
    const countdown = document.querySelector('[data-testid="phase-countdown"]');
    const chatPanel = document.querySelector('[data-testid="chat-panel"]');
    const waitingLobby = document.querySelector('[data-testid="waiting-lobby-overlay"]');
    const silenceBlackout = document.querySelector('[data-testid="silence-blackout"]');
    const gestureButton = document.querySelector('[data-testid="gesture-play-cta"]');
    const recoveryRetry = document.querySelector('[data-testid="recovery-retry"]');
    const subtitleToggle = document.querySelector('[data-testid="subtitle-toggle"]');
    const footer = document.querySelector('[data-testid="video-status-note"]');
    const composerInput = document.querySelector(
      '[data-testid="chat-composer-input"]',
    ) as HTMLTextAreaElement | null;
    const inviteInput = document.querySelector('[data-testid="invite-code-input"]');
    const identityInput = document.querySelector('[data-testid="identity-nickname-input"]');
    const probe = (
      window as unknown as { __HLS_E2E_PROBE__?: PhaseProbeState }
    ).__HLS_E2E_PROBE__;

    return {
      phase: phaseBadge?.getAttribute("data-phase") ?? null,
      countdownLabel: countdown?.getAttribute("data-countdown-label") ?? null,
      chatOpen: chatPanel?.getAttribute("data-chat-open") ?? null,
      chatPhase: chatPanel?.getAttribute("data-chat-phase") ?? null,
      waitingLobbyVisible: isVisible(waitingLobby),
      silenceBlackoutVisible: isVisible(silenceBlackout),
      gestureVisible: isVisible(gestureButton),
      recoveryRetryVisible: isVisible(recoveryRetry),
      subtitleToggleVisible: isVisible(subtitleToggle),
      footerDisplayState: footer?.getAttribute("data-footer-display-state") ?? null,
      footerText: footer?.textContent?.trim() ?? "",
      composerDisabled: composerInput?.disabled ?? true,
      inviteVisible: isVisible(inviteInput),
      identityVisible: isVisible(identityInput),
      probe: probe ?? null,
    };
  });
}

async function attachDiagnostics(
  page: Page,
  testInfo: TestInfo,
  reason: string,
): Promise<void> {
  const [snapshot, roomConfig] = await Promise.all([
    readPhaseUiSnapshot(page).catch(() => null),
    getCiRoomConfig(ROOM).catch((error: unknown) => {
      if (error instanceof Error) {
        return { error: error.message };
      }
      return { error: String(error) };
    }),
  ]);

  const safePayload = redactUnknown(
    {
      reason,
      room: ROOM,
      pageUrl: page.url(),
      snapshot,
      roomConfig,
    },
    AUTH_KEYS,
  );
  const body = JSON.stringify(safePayload, null, 2);

  await testInfo.attach("phase-transition-diagnostics", {
    body,
    contentType: "application/json",
  });
  await writeFile(
    testInfo.outputPath("phase-transition-diagnostics.json"),
    body,
    "utf8",
  );
}

async function assertInitialPhaseState(
  page: Page,
  expectedPhase: "WAITING" | "LIVE",
  expectedCountdownLabel: string,
  expectedChatOpen: "true" | "false",
): Promise<PhaseUiSnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPhaseUiSnapshot(page);
        if (
          snapshot.phase === expectedPhase &&
          snapshot.countdownLabel === expectedCountdownLabel &&
          snapshot.chatOpen === expectedChatOpen &&
          snapshot.inviteVisible === false &&
          snapshot.identityVisible === false
        ) {
          return true;
        }

        return false;
      },
      {
        timeout: 20_000,
        intervals: [POLL_INTERVAL_MS, 500, 1_000],
        message: `Expected initial ${expectedPhase} UI state with countdown "${expectedCountdownLabel}".`,
      },
    )
    .toBe(true);

  return readPhaseUiSnapshot(page);
}

async function resolveWaitingBranch(page: Page): Promise<WaitingBranch> {
  let resolvedBranch: WaitingBranch | "pending" | "unexpected_phase" = "pending";
  await expect
    .poll(
      async () => {
        const snapshot = await readPhaseUiSnapshot(page);
        if (snapshot.phase !== "WAITING") {
          resolvedBranch = "unexpected_phase";
          return resolvedBranch;
        }
        if (snapshot.gestureVisible) {
          resolvedBranch = "gesture_required";
          return resolvedBranch;
        }
        if (snapshot.waitingLobbyVisible) {
          resolvedBranch = "gesture_not_required";
          return resolvedBranch;
        }
        resolvedBranch = "pending";
        return resolvedBranch;
      },
      {
        timeout: UI_BRANCH_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS, 500, 1_000],
        message: "Expected WAITING room to resolve into a gesture or waiting-lobby branch.",
      },
    )
    .not.toBe("pending");

  if (resolvedBranch === "pending" || resolvedBranch === "unexpected_phase") {
    throw new Error("WAITING branch selection failed because the room left WAITING early.");
  }

  return resolvedBranch;
}

async function satisfyWaitingBranch(
  page: Page,
  branch: WaitingBranch,
): Promise<void> {
  if (branch === "gesture_required") {
    await page.getByTestId("gesture-play-cta").click({
      timeout: 6_000,
    });

    await expect
      .poll(
        async () => {
          const snapshot = await readPhaseUiSnapshot(page);
          return (
            snapshot.waitingLobbyVisible &&
            snapshot.footerDisplayState === "WAITING_PRIMED"
          );
        },
        {
          timeout: UI_BRANCH_TIMEOUT_MS,
          intervals: [POLL_INTERVAL_MS, 500, 1_000],
          message:
            "Expected the gesture-required WAITING branch to settle into a primed waiting lobby.",
        },
      )
      .toBe(true);
    return;
  }

  await expect
    .poll(
      async () => {
        const snapshot = await readPhaseUiSnapshot(page);
        return snapshot.waitingLobbyVisible && snapshot.gestureVisible === false;
      },
      {
        timeout: UI_BRANCH_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS, 500, 1_000],
        message: "Expected the non-gesture WAITING branch to show the waiting lobby.",
      },
    )
    .toBe(true);
}

async function resolveLiveEntryBranch(page: Page): Promise<LiveEntryBranch> {
  const snapshot = await readPhaseUiSnapshot(page);
  if (!snapshot.gestureVisible) {
    return "gesture_not_required";
  }

  await page.getByTestId("gesture-play-cta").click({
    timeout: 6_000,
  });
  await expect
    .poll(
      async () => (await readPhaseUiSnapshot(page)).gestureVisible,
      {
        timeout: UI_BRANCH_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS, 500, 1_000],
        message: "Expected gesture CTA to clear after LIVE entry tap.",
      },
    )
    .toBe(false);

  return "gesture_required";
}

async function waitForPhase(page: Page, expectedPhase: "LIVE" | "SILENCE"): Promise<PhaseUiSnapshot> {
  await expect
    .poll(
      async () => (await readPhaseUiSnapshot(page)).phase,
      {
        timeout: PHASE_TRANSITION_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS, 500, 1_000],
        message: `Expected room to transition into ${expectedPhase}.`,
      },
    )
    .toBe(expectedPhase);

  return readPhaseUiSnapshot(page);
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await attachDiagnostics(page, testInfo, "Phase transition test failed.");
  }
});

test.describe("Phase Transition UI", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(PHASE_TRANSITION_TIMEOUT_MS + 70_000);
  test.skip(!INVITE_CODE, "Missing HLS_TEST_INVITE_CODE.");

  test.afterAll(async () => {
    try {
      await resetCiRoomStart(ROOM, CLEANUP_WAITING_OFFSET_SEC);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown cleanup error: ${String(error)}`;
      process.stderr.write(`Phase suite cleanup reset failed: ${message}\n`);
    }
  });

  test("WAITING transitions into LIVE with branch-aware UI proof", async ({
    page,
    context,
  }) => {
    await resetCiRoomStart(ROOM, WAITING_TO_LIVE_OFFSET_SEC);
    await openPhaseRoom(page, context);

    const initialSnapshot = await assertInitialPhaseState(
      page,
      "WAITING",
      "Starts in",
      "false",
    );
    expect(initialSnapshot.chatPhase).toBe("WAITING");

    const branch = await resolveWaitingBranch(page);
    await satisfyWaitingBranch(page, branch);

    const liveSnapshot = await waitForPhase(page, "LIVE");
    expect(liveSnapshot.countdownLabel).toBe("Silence in");
    expect(liveSnapshot.waitingLobbyVisible).toBe(false);
    expect(liveSnapshot.chatOpen).toBe("true");
    expect(liveSnapshot.chatPhase).toBe("LIVE");
  });

  test("SILENCE has precedence over live playback UI", async ({
    page,
    context,
  }) => {
    const roomConfig: CiRoomConfig = await getCiRoomConfig(ROOM);
    if (roomConfig.filmDurationSec < MIN_FILM_DURATION_SEC) {
      throw new Error(
        `CI room "${ROOM}" must provide filmDurationSec >= ${MIN_FILM_DURATION_SEC} for SILENCE testing.`,
      );
    }

    await resetCiRoomStart(ROOM, -(roomConfig.filmDurationSec - SILENCE_LEAD_SEC));
    await openPhaseRoom(page, context);

    const liveEntrySnapshot = await assertInitialPhaseState(
      page,
      "LIVE",
      "Silence in",
      "true",
    );
    expect(liveEntrySnapshot.chatPhase).toBe("LIVE");

    await resolveLiveEntryBranch(page);

    const silenceSnapshot = await waitForPhase(page, "SILENCE");
    expect(silenceSnapshot.countdownLabel).toBe("Discussion opens in");
    expect(silenceSnapshot.silenceBlackoutVisible).toBe(true);
    expect(silenceSnapshot.gestureVisible).toBe(false);
    expect(silenceSnapshot.waitingLobbyVisible).toBe(false);
    expect(silenceSnapshot.recoveryRetryVisible).toBe(false);
    expect(silenceSnapshot.subtitleToggleVisible).toBe(false);
    expect(silenceSnapshot.footerDisplayState).toBe("SILENCE");
    expect(silenceSnapshot.chatOpen).toBe("false");
    expect(silenceSnapshot.chatPhase).toBe("SILENCE");
    await expect(page.getByTestId("chat-composer-input")).toBeDisabled();

    const response = await context.request.post(roomMessagesUrl(), {
      data: {
        id: "phase-silence-guard",
        nickname: PHASE_IDENTITY.nickname,
        avatarSeed: PHASE_IDENTITY.avatarSeed,
        signature: PHASE_SIGNATURE,
        text: "Blocked during silence",
      },
    });
    expect(response.status()).toBe(403);
  });
});
