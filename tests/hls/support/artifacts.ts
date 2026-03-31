import { writeFile } from "node:fs/promises";
import type { Page, TestInfo } from "@playwright/test";
import { redactUnknown } from "../../../scripts/hls/redact";
import { getCiRoomConfig } from "../../../scripts/hls/ciRoomHelper";
import { readPhaseUiSnapshot } from "./probe";

export async function attachDiagnostics(
  page: Page,
  testInfo: TestInfo,
  reason: string,
  room: string,
  authKeys: Set<string>,
): Promise<void> {
  const [snapshot, roomConfig] = await Promise.all([
    readPhaseUiSnapshot(page).catch(() => null),
    getCiRoomConfig(room).catch((error: unknown) => {
      if (error instanceof Error) {
        return { error: error.message };
      }
      return { error: String(error) };
    }),
  ]);

  const safePayload = redactUnknown(
    {
      reason,
      room,
      pageUrl: page.url(),
      snapshot,
      roomConfig,
    },
    authKeys,
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
