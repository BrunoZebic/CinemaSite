import type { BrowserContext, Page } from "@playwright/test";

export async function grantInviteAccess(
  context: BrowserContext,
  roomAccessUrl: string,
  inviteCode: string,
): Promise<void> {
  const response = await context.request.post(roomAccessUrl, {
    data: { inviteCode },
  });

  if (!response.ok()) {
    const payload = await response.text().catch(() => "");
    throw new Error(
      `Failed to obtain invite access (status ${response.status()}): ${payload}`,
    );
  }
}

export async function seedIdentityBeforeNavigation(
  page: Page,
  identity: object,
  storageKey: string,
): Promise<void> {
  await page.addInitScript(
    ({ storageKey: key, identity: id }) => {
      window.localStorage.removeItem(key);
      window.localStorage.setItem(key, JSON.stringify(id));
    },
    { storageKey, identity },
  );
}
