import { defineConfig } from "@playwright/test";

const ROOM_BASE_URL =
  process.env.HLS_TEST_BASE_URL?.trim() ||
  process.env.HLS_E2E_BASE_URL?.trim() ||
  "http://localhost:3100";
const ROOM_WEBSERVER_ENABLED = process.env.PW_ROOM_WEBSERVER === "1";
const RAW_HAR_ENABLED = process.env.HLS_SMOKE_RAW_HAR === "1";

const sharedChromiumArgs = ["--autoplay-policy=no-user-gesture-required"];

export default defineConfig({
  testDir: ".",
  timeout: 60_000,
  outputDir: "test-results/playwright",
  reporter: [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "hls-smoke",
      testMatch: ["tests/hls/hls-playback.spec.ts"],
      fullyParallel: false,
      workers: 1,
      use: {
        browserName: "chromium",
        headless: true,
        launchOptions: {
          args: sharedChromiumArgs,
        },
        ...(RAW_HAR_ENABLED
          ? {
              recordHar: {
                path: "test-results/playwright/hls-smoke.raw.har",
                mode: "full",
                content: "embed",
              },
            }
          : {}),
      },
    },
    {
      name: "room-e2e-chromium",
      testMatch: ["tests/hls/room-playback.spec.ts"],
      fullyParallel: false,
      workers: 1,
      use: {
        browserName: "chromium",
        headless: true,
        baseURL: ROOM_BASE_URL,
        launchOptions: {
          args: sharedChromiumArgs,
        },
      },
    },
    {
      name: "room-e2e-webkit",
      testMatch: ["tests/hls/room-playback.spec.ts"],
      fullyParallel: false,
      workers: 1,
      use: {
        browserName: "webkit",
        headless: true,
        baseURL: ROOM_BASE_URL,
      },
    },
  ],
  ...(ROOM_WEBSERVER_ENABLED
    ? {
        webServer: {
          command: "corepack pnpm dev --port 3100",
          url: ROOM_BASE_URL,
          timeout: 180_000,
          reuseExistingServer: true,
        },
      }
    : {}),
});
