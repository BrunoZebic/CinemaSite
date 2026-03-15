import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import path from "node:path";
import { getStringFlag, parseArgs } from "./args";
import { loadLocalEnv } from "./env";

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

function shouldUseLocalWebServer(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const room =
    getStringFlag(args.flags, "room") ??
    process.env.HLS_TEST_ROOM?.trim() ??
    process.env.HLS_E2E_ROOM?.trim() ??
    "demo";
  const baseUrl =
    getStringFlag(args.flags, "base-url") ??
    process.env.HLS_TEST_BASE_URL?.trim() ??
    process.env.HLS_E2E_BASE_URL?.trim() ??
    "http://localhost:3100";
  const inviteCode =
    getStringFlag(args.flags, "invite-code") ??
    process.env.HLS_TEST_INVITE_CODE?.trim() ??
    process.env.HLS_E2E_INVITE_CODE?.trim() ??
    "";
  const project =
    getStringFlag(args.flags, "project") ??
    process.env.HLS_TEST_PROJECT?.trim() ??
    process.env.HLS_E2E_PROJECT?.trim() ??
    "room-e2e-chromium";

  if (!inviteCode) {
    throw new Error("Missing HLS_TEST_INVITE_CODE.");
  }

  const env = {
    ...process.env,
    PW_ROOM_WEBSERVER: shouldUseLocalWebServer(baseUrl) ? "1" : "0",
    HLS_TEST_ROOM: room,
    HLS_TEST_BASE_URL: baseUrl,
    HLS_TEST_INVITE_CODE: inviteCode,
    HLS_TEST_PROJECT: project,
    HLS_E2E_ROOM: room,
    HLS_E2E_BASE_URL: baseUrl,
    HLS_E2E_INVITE_CODE: inviteCode,
    HLS_E2E_PROJECT: project,
  };

  const playwrightCli = path.resolve(
    process.cwd(),
    "node_modules/@playwright/test/cli.js",
  );
  const argsList = [
    playwrightCli,
    "test",
    "tests/hls/room-playback.spec.ts",
    `--project=${project}`,
  ];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, argsList, {
      stdio: "inherit",
      env,
      shell: false,
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
