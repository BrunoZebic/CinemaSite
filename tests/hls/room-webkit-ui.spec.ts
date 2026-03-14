import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  INVITE_CODE,
  attachRoomDiagnostics,
  completeIdentityFlow,
  completeInviteFlow,
  roomUrl,
} from "./room-e2e-shared";

type ViewportGeometry = {
  viewport: {
    width: number;
    height: number;
  };
  modalRect: DOMRectSnapshot | null;
  buttonRect: DOMRectSnapshot | null;
  drawerRect: DOMRectSnapshot | null;
  drawerTransform: string | null;
};

type DOMRectSnapshot = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

function inViewport(rect: DOMRectSnapshot | null, viewport: { width: number; height: number }) {
  if (!rect) {
    return false;
  }

  return (
    rect.top >= -1 &&
    rect.left >= -1 &&
    rect.bottom <= viewport.height + 1 &&
    rect.right <= viewport.width + 1
  );
}

async function readIdentityGeometry(page: Page): Promise<ViewportGeometry> {
  return page.evaluate(() => {
    function snapshotRect(element: Element | null): DOMRectSnapshot | null {
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }

    const modal = document.querySelector('[data-testid="identity-modal-root"]');
    const button = document.querySelector('[data-testid="identity-submit"]');
    const drawer = document.querySelector('[data-testid="chat-drawer"]');

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      modalRect: snapshotRect(modal),
      buttonRect: snapshotRect(button),
      drawerRect: snapshotRect(drawer),
      drawerTransform: drawer ? getComputedStyle(drawer).transform : null,
    };
  });
}

async function assertDebugPanelMounted(page: Page): Promise<void> {
  await expect(page.getByTestId("sync-debug-panel")).toBeVisible({
    timeout: 45_000,
  });
}

async function attachGeometryFailure(
  page: Page,
  testInfo: TestInfo,
  stage: string,
  reason: string,
): Promise<void> {
  const geometry = await readIdentityGeometry(page).catch(() => null);
  await attachRoomDiagnostics(page, testInfo, stage, reason, {
    geometry,
  });
}

test.beforeEach(async ({ context }) => {
  await context.clearCookies();
});

test.describe("Room Playback WebKit UI", () => {
  test("real sync debug panel stays non-interactive on iPhone WebKit", async ({
    page,
  }) => {
    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await assertDebugPanelMounted(page);

    const pointerEvents = await page.getByTestId("sync-debug-panel").evaluate((element) => {
      const child = element.querySelector("*");
      return {
        root: getComputedStyle(element).pointerEvents,
        child: child ? getComputedStyle(child).pointerEvents : null,
      };
    });

    expect(pointerEvents.root).toBe("none");
    expect(pointerEvents.child).toBe("none");
  });

  test("invite and identity flow stays tappable on iPhone WebKit while debug panel is mounted", async ({
    page,
  }) => {
    test.skip(!INVITE_CODE, "Missing HLS_TEST_INVITE_CODE.");

    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await assertDebugPanelMounted(page);
    await completeInviteFlow(page);
    await completeIdentityFlow(page, {
      nickname: "WebkitTapTester",
    });

    await expect(page.getByTestId("identity-nickname-input")).toBeHidden({
      timeout: 10_000,
    });
  });

  test("identity modal is viewport-anchored, not drawer-anchored", async ({
    page,
  }, testInfo) => {
    test.skip(!INVITE_CODE, "Missing HLS_TEST_INVITE_CODE.");

    await page.goto(roomUrl(), {
      waitUntil: "domcontentloaded",
    });
    await assertDebugPanelMounted(page);
    await completeInviteFlow(page);
    await expect(page.getByTestId("identity-modal-root")).toBeVisible({
      timeout: 20_000,
    });

    const geometry = await readIdentityGeometry(page);

    try {
      expect(inViewport(geometry.modalRect, geometry.viewport)).toBe(true);
      expect(inViewport(geometry.buttonRect, geometry.viewport)).toBe(true);
      expect(geometry.drawerTransform).not.toBeNull();
      expect(geometry.drawerTransform).not.toBe("none");
      expect(geometry.drawerRect?.left ?? 0).toBeGreaterThanOrEqual(
        geometry.viewport.width - 1,
      );
    } catch (error) {
      await attachGeometryFailure(
        page,
        testInfo,
        "webkit_identity_geometry",
        "Identity modal geometry was shifted out of the iPhone viewport.",
      );
      throw error;
    }

    await completeIdentityFlow(page, {
      nickname: "WebkitGeometryTester",
    });
  });
});
