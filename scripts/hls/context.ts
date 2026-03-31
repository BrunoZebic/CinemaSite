import { loadLocalEnv } from "./env";

export type HarnessContext = {
  room: string;
  baseUrl: string;
  inviteCode: string;
};

export function loadHarnessContext(): HarnessContext {
  loadLocalEnv();
  const room =
    process.env.HLS_TEST_ROOM?.trim() ?? process.env.HLS_E2E_ROOM?.trim() ?? "demo";
  const baseUrl =
    process.env.HLS_TEST_BASE_URL?.trim() ??
    process.env.HLS_E2E_BASE_URL?.trim() ??
    "http://localhost:3100";
  const inviteCode =
    process.env.HLS_TEST_INVITE_CODE?.trim() ??
    process.env.HLS_E2E_INVITE_CODE?.trim() ??
    "";
  return { room, baseUrl, inviteCode };
}
