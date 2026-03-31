import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { buildAuthKeySet } from "../../scripts/hls/redact";
import { loadHarnessContext } from "../../scripts/hls/context";
import {
  getCiRoomConfig,
  resetCiRoomStart,
  setCiRoomPosterImage,
  type CiRoomConfig,
} from "../../scripts/hls/ciRoomHelper";
import type {
  PhaseUiSnapshot,
  PhaseTransitionKind,
  PremierePhase,
} from "../../lib/harness/probe-contract";
import { readPhaseUiSnapshot } from "./support/probe";
import { attachDiagnostics } from "./support/artifacts";
import { grantInviteAccess, seedIdentityBeforeNavigation } from "./support/access";

const { room: ROOM, baseUrl: BASE_URL, inviteCode: INVITE_CODE } = loadHarnessContext();
const AUTH_KEYS = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
const WAITING_TO_LIVE_OFFSET_SEC = 60;
const SILENCE_LEAD_SEC = 45;
const DISCUSSION_LEAD_SEC = 8;
const CLOSED_LEAD_SEC = 8;
const CLEANUP_WAITING_OFFSET_SEC = 120;
const MIN_FILM_DURATION_SEC = 60;
const PHASE_TRANSITION_TIMEOUT_MS = 95_000;
const UI_BRANCH_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;
const POSTER_FIXTURE_URL = "/phase-poster-demo.svg";
const IDENTITY_STORAGE_KEY = "premiere.identity.v1";
const PHASE_IDENTITY = {
  nickname: "PhaseTester",
  avatarSeed: "phase-e2e-seed",
  createdAt: 1700000000000,
};
const PHASE_SIGNATURE = "phasetester::phase-e2e-seed";


type WaitingBranch = "gesture_required" | "gesture_not_required";
type LiveEntryBranch = "gesture_required" | "gesture_not_required";

let originalPosterImageUrl: string | null = null;
let posterFieldSupported = false;

function roomUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/premiere/${encodeURIComponent(ROOM)}`;
}

function roomAccessUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/api/rooms/${encodeURIComponent(ROOM)}/access`;
}

function roomMessagesUrl(): string {
  return `${BASE_URL.replace(/\/+$/, "")}/api/rooms/${encodeURIComponent(ROOM)}/messages`;
}

async function openPhaseRoom(page: Page, context: BrowserContext): Promise<void> {
  await seedIdentityBeforeNavigation(page, PHASE_IDENTITY, IDENTITY_STORAGE_KEY);
  await grantInviteAccess(context, roomAccessUrl(), INVITE_CODE);
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


async function assertInitialPhaseState(
  page: Page,
  expectedPhase: "WAITING" | "LIVE" | "SILENCE" | "DISCUSSION",
  expectedCountdownLabel: string,
  expectedChatOpen: "true" | "false",
): Promise<PhaseUiSnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPhaseUiSnapshot(page);
        if (
          snapshot.phase === expectedPhase &&
          snapshot.shellPhase === expectedPhase &&
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

async function waitForTransitionKind(
  page: Page,
  expectedTransitionKind: Exclude<PhaseTransitionKind, "none">,
): Promise<PhaseUiSnapshot> {
  await page.waitForFunction(
    (expectedKind) => {
      const shell = document.querySelector('[data-testid="premiere-shell"]');
      const playerShell = document.querySelector('[data-testid="player-presentation-shell"]');
      if (!(shell instanceof HTMLElement) || !(playerShell instanceof HTMLElement)) {
        return false;
      }

      return (
        shell.getAttribute("data-transition-kind") === expectedKind &&
        shell.getAttribute("data-phase-visual-state") === "transitioning" &&
        playerShell.getAttribute("data-player-transition-kind") === expectedKind &&
        playerShell.getAttribute("data-player-phase-visual-state") === "transitioning"
      );
    },
    expectedTransitionKind,
    {
      timeout: PHASE_TRANSITION_TIMEOUT_MS,
      polling: 50,
    },
  );

  return readPhaseUiSnapshot(page);
}

async function waitForSteadyPhase(
  page: Page,
  expectedPhase: PremierePhase,
): Promise<PhaseUiSnapshot> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPhaseUiSnapshot(page);
        if (
          snapshot.phase === expectedPhase &&
          snapshot.shellPhase === expectedPhase &&
          snapshot.phaseVisualState === "steady" &&
          snapshot.transitionKind === "none" &&
          snapshot.playerPhaseVisualState === "steady" &&
          snapshot.playerTransitionKind === "none"
        ) {
          return expectedPhase;
        }
        return snapshot.phase;
      },
      {
        timeout: PHASE_TRANSITION_TIMEOUT_MS,
        intervals: [POLL_INTERVAL_MS, 500, 1_000],
        message: `Expected room to settle into ${expectedPhase}.`,
      },
    )
    .toBe(expectedPhase);

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

function discussionStartOffsetSec(roomConfig: CiRoomConfig): number {
  const leadSeconds = Math.min(
    DISCUSSION_LEAD_SEC,
    Math.max(2, roomConfig.silenceDurationSec - 2),
  );
  return -(
    roomConfig.filmDurationSec +
    roomConfig.silenceDurationSec -
    leadSeconds
  );
}

function closedStartOffsetSec(roomConfig: CiRoomConfig): number {
  const discussionDurationSec = roomConfig.discussionDurationMin * 60;
  const leadSeconds = Math.min(CLOSED_LEAD_SEC, Math.max(2, discussionDurationSec - 2));
  return -(
    roomConfig.filmDurationSec +
    roomConfig.silenceDurationSec +
    discussionDurationSec -
    leadSeconds
  );
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await attachDiagnostics(page, testInfo, "Phase transition test failed.", ROOM, AUTH_KEYS);
  }
});

test.describe("Phase Transition UI", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(PHASE_TRANSITION_TIMEOUT_MS + 70_000);
  test.skip(!INVITE_CODE, "Missing HLS_TEST_INVITE_CODE.");

  test.beforeAll(async () => {
    const roomConfig = await getCiRoomConfig(ROOM);
    originalPosterImageUrl = roomConfig.posterImageUrl;
    posterFieldSupported = roomConfig.supportsPosterField;
    if (posterFieldSupported) {
      await setCiRoomPosterImage(ROOM, POSTER_FIXTURE_URL);
    }
  });

  test.afterAll(async () => {
    try {
      await resetCiRoomStart(ROOM, CLEANUP_WAITING_OFFSET_SEC);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown cleanup error: ${String(error)}`;
      process.stderr.write(`Phase suite cleanup reset failed: ${message}\n`);
    }

    try {
      if (posterFieldSupported) {
        await setCiRoomPosterImage(ROOM, originalPosterImageUrl);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown poster cleanup error: ${String(error)}`;
      process.stderr.write(`Phase suite cleanup poster reset failed: ${message}\n`);
    }
  });

  test("WAITING transitions into LIVE with branch-aware ritual state", async ({
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
    expect(initialSnapshot.phaseVisualState).toBe("steady");
    expect(initialSnapshot.transitionKind).toBe("none");
    expect(initialSnapshot.playerPhaseVisualState).toBe("steady");
    expect(initialSnapshot.playerTransitionKind).toBe("none");
    expect(initialSnapshot.screenVisualState).toBe("waiting-static");
    expect(initialSnapshot.chatVisualState).toBe("dimmed");
    expect(initialSnapshot.chatPhase).toBe("WAITING");

    const branch = await resolveWaitingBranch(page);
    await satisfyWaitingBranch(page, branch);
    const transitionSnapshot = await waitForTransitionKind(page, "to-live");
    expect(transitionSnapshot.phaseVisualState).toBe("transitioning");
    expect(transitionSnapshot.transitionKind).toBe("to-live");
    expect(transitionSnapshot.playerPhaseVisualState).toBe("transitioning");
    expect(transitionSnapshot.playerTransitionKind).toBe("to-live");

    const liveSnapshot = await waitForSteadyPhase(page, "LIVE");
    expect(liveSnapshot.countdownLabel).toBe("Silence in");
    expect(liveSnapshot.waitingLobbyVisible).toBe(false);
    expect(liveSnapshot.chatOpen).toBe("true");
    expect(liveSnapshot.chatPhase).toBe("LIVE");
    expect(liveSnapshot.screenVisualState).toBe("live-motion");
    expect(liveSnapshot.chatVisualState).toBe("dimmed");
  });

  test("SILENCE keeps blackout precedence and hides chat presentation", async ({
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
    expect(liveEntrySnapshot.chatVisualState).toBe("dimmed");
    expect(liveEntrySnapshot.screenVisualState).toBe("live-motion");
    expect(liveEntrySnapshot.playerPhaseVisualState).toBe("steady");
    expect(liveEntrySnapshot.playerTransitionKind).toBe("none");

    await resolveLiveEntryBranch(page);
    const transitionSnapshot = await waitForTransitionKind(page, "to-silence");
    expect(transitionSnapshot.playerPhaseVisualState).toBe("transitioning");
    expect(transitionSnapshot.playerTransitionKind).toBe("to-silence");

    const silenceSnapshot = await waitForSteadyPhase(page, "SILENCE");
    expect(silenceSnapshot.countdownLabel).toBe("Discussion opens in");
    expect(silenceSnapshot.silenceBlackoutVisible).toBe(true);
    expect(silenceSnapshot.gestureVisible).toBe(false);
    expect(silenceSnapshot.waitingLobbyVisible).toBe(false);
    expect(silenceSnapshot.recoveryRetryVisible).toBe(false);
    expect(silenceSnapshot.subtitleToggleVisible).toBe(false);
    expect(silenceSnapshot.footerDisplayState).toBe("SILENCE");
    expect(silenceSnapshot.chatOpen).toBe("false");
    expect(silenceSnapshot.chatPhase).toBe("SILENCE");
    expect(silenceSnapshot.screenVisualState).toBe("silence-black");
    expect(silenceSnapshot.chatVisualState).toBe("hidden");
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

  test("DISCUSSION restores bright chat and reveals the configured poster", async ({
    page,
    context,
  }) => {
    const roomConfig = await getCiRoomConfig(ROOM);
    await resetCiRoomStart(ROOM, discussionStartOffsetSec(roomConfig));
    await openPhaseRoom(page, context);

    const silenceSnapshot = await assertInitialPhaseState(
      page,
      "SILENCE",
      "Discussion opens in",
      "false",
    );
    expect(silenceSnapshot.screenVisualState).toBe("silence-black");
    expect(silenceSnapshot.chatVisualState).toBe("hidden");
    expect(silenceSnapshot.playerPhaseVisualState).toBe("steady");
    expect(silenceSnapshot.playerTransitionKind).toBe("none");

    const transitionSnapshot = await waitForTransitionKind(page, "to-discussion");
    expect(transitionSnapshot.playerPhaseVisualState).toBe("transitioning");
    expect(transitionSnapshot.playerTransitionKind).toBe("to-discussion");

    const discussionSnapshot = await waitForSteadyPhase(page, "DISCUSSION");
    expect(discussionSnapshot.countdownLabel).toBe("Room closes in");
    expect(discussionSnapshot.chatOpen).toBe("true");
    expect(discussionSnapshot.chatPhase).toBe("DISCUSSION");
    expect(discussionSnapshot.chatVisualState).toBe("bright");
    expect(discussionSnapshot.screenVisualState).toBe(
      posterFieldSupported ? "discussion-poster" : "discussion-static",
    );
    expect(discussionSnapshot.posterVisible).toBe(posterFieldSupported);
    expect(discussionSnapshot.silenceBlackoutVisible).toBe(false);
    await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  });

  test("CLOSED resolves into a muted poster-backed archive state", async ({
    page,
    context,
  }) => {
    const roomConfig = await getCiRoomConfig(ROOM);
    await resetCiRoomStart(ROOM, closedStartOffsetSec(roomConfig));
    await openPhaseRoom(page, context);

    const discussionSnapshot = await assertInitialPhaseState(
      page,
      "DISCUSSION",
      "Room closes in",
      "true",
    );
    expect(discussionSnapshot.chatVisualState).toBe("bright");
    expect(discussionSnapshot.screenVisualState).toBe(
      posterFieldSupported ? "discussion-poster" : "discussion-static",
    );
    expect(discussionSnapshot.posterVisible).toBe(posterFieldSupported);
    expect(discussionSnapshot.playerPhaseVisualState).toBe("steady");
    expect(discussionSnapshot.playerTransitionKind).toBe("none");

    const transitionSnapshot = await waitForTransitionKind(page, "to-closed");
    expect(transitionSnapshot.playerPhaseVisualState).toBe("transitioning");
    expect(transitionSnapshot.playerTransitionKind).toBe("to-closed");

    const closedSnapshot = await waitForSteadyPhase(page, "CLOSED");
    expect(closedSnapshot.countdownLabel).toBe(null);
    expect(closedSnapshot.chatOpen).toBe("false");
    expect(closedSnapshot.chatPhase).toBe("CLOSED");
    expect(closedSnapshot.chatVisualState).toBe("muted");
    expect(closedSnapshot.screenVisualState).toBe(
      posterFieldSupported ? "closed-poster" : "closed-static",
    );
    expect(closedSnapshot.posterVisible).toBe(posterFieldSupported);
    expect(closedSnapshot.composerDisabled).toBe(true);
  });
});
