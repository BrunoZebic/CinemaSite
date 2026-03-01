import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { assertTokenEnforcement } from "./assertTokenEnforcement";
import { getStringFlag, parseArgs } from "./args";
import { loadLocalEnv } from "./env";
import { getSignedUrlForRoom } from "./printSignedUrl";
import { buildAuthKeySet, redactText, redactUrl } from "./redact";

type FailureClass =
  | "timeout"
  | "network_error"
  | "http_5xx"
  | "http_4xx"
  | "token_guard"
  | "config_error"
  | "unknown";

type SmokeResultFile = {
  ok: boolean;
  failureClass?: FailureClass;
  message?: string;
};

type SmokeRunResult = {
  ok: boolean;
  failureClass: FailureClass;
  message: string;
};

class TokenGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenGuardError";
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(entry).href;
}

function isTruthy(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() !== "false";
}

function retryableFailureClass(failureClass: FailureClass): boolean {
  return (
    failureClass === "timeout" ||
    failureClass === "network_error" ||
    failureClass === "http_5xx"
  );
}

function makeResultFilePath(): string {
  return path.join(os.tmpdir(), `hls-smoke-result-${randomUUID()}.json`);
}

async function runPlaywrightSmoke(url: string): Promise<SmokeRunResult> {
  const resultFile = makeResultFilePath();
  const env = {
    ...process.env,
    HLS_TEST_URL: url,
    HLS_SMOKE_RESULT_FILE: resultFile,
  };

  const playwrightCli = path.resolve(
    process.cwd(),
    "node_modules/@playwright/test/cli.js",
  );
  const args = [
    playwrightCli,
    "test",
    "tests/hls/hls-playback.spec.ts",
    "--project=hls-smoke",
  ];

  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env,
      shell: false,
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve(code ?? 1));
  });

  let parsed: SmokeResultFile = {
    ok: exitCode === 0,
  };

  try {
    if (existsSync(resultFile)) {
      const raw = await readFile(resultFile, "utf8");
      parsed = JSON.parse(raw) as SmokeResultFile;
    }
  } catch {
    parsed = {
      ok: exitCode === 0,
      failureClass: "unknown",
      message: "Smoke failed and result file was unreadable.",
    };
  } finally {
    if (existsSync(resultFile)) {
      await rm(resultFile, {
        force: true,
      });
    }
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      failureClass: parsed.failureClass ?? "unknown",
      message: parsed.message ?? `Smoke test failed (exit code ${exitCode}).`,
    };
  }

  if (parsed.ok) {
    return {
      ok: true,
      failureClass: "unknown",
      message: "Smoke test passed.",
    };
  }

  return {
    ok: false,
    failureClass: parsed.failureClass ?? "unknown",
    message: parsed.message ?? `Smoke test failed (exit code ${exitCode}).`,
  };
}

async function runBunnyTokenGuard(
  signedUrl: string,
  authKeys: Set<string>,
): Promise<void> {
  let guard;
  try {
    guard = await assertTokenEnforcement(signedUrl, {
      authKeyExtras: process.env.HLS_AUTH_KEYS_EXTRA ?? null,
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    throw new TokenGuardError(message);
  }

  for (const warning of guard.warnings) {
    process.stdout.write(`WARN ${warning}\n`);
  }

  for (const check of guard.checks) {
    const status = check.passed ? "PASS" : "FAIL";
    process.stdout.write(
      `${status} ${check.label} status=${check.status} ${redactUrl(
        check.url,
        authKeys,
      )}\n`,
    );
  }

  if (!guard.ok) {
    throw new TokenGuardError("Token enforcement guard failed.");
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const args = parseArgs(process.argv.slice(2));
  const authKeys = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
  const room =
    getStringFlag(args.flags, "room") ??
    process.env.HLS_TEST_ROOM?.trim() ??
    "demo";
  const directUrl = getStringFlag(args.flags, "url");
  const mode = directUrl ? "url" : "bunny";
  const requireTokenGuard = isTruthy(
    process.env.HLS_REQUIRE_TOKEN_ENFORCEMENT ?? "true",
  );

  if (process.env.HLS_SMOKE_RAW_HAR === "1") {
    process.stdout.write(
      "WARN HLS_SMOKE_RAW_HAR=1 stores raw URLs and may expose tokens in artifacts.\n",
    );
  }

  let attempt = 0;
  let maxAttempts = 1;
  if (mode === "bunny") {
    maxAttempts = 2;
  }

  while (attempt < maxAttempts) {
    attempt += 1;
    process.stdout.write(`HLS smoke attempt ${attempt}/${maxAttempts}\n`);

    let urlForAttempt = directUrl;
    try {
      if (!urlForAttempt) {
        urlForAttempt = await getSignedUrlForRoom({
          room,
        });
      }

      if (!urlForAttempt) {
        throw new Error("Missing URL for smoke run.");
      }

      process.stdout.write(`Using URL ${redactUrl(urlForAttempt, authKeys)}\n`);

      if (mode === "bunny" && requireTokenGuard) {
        await runBunnyTokenGuard(urlForAttempt, authKeys);
      }

      const smokeResult = await runPlaywrightSmoke(urlForAttempt);
      if (smokeResult.ok) {
        process.stdout.write("HLS smoke succeeded.\n");
        return;
      }

      process.stdout.write(
        `HLS smoke failed: class=${smokeResult.failureClass} message=${redactText(
          smokeResult.message,
          authKeys,
        )}\n`,
      );

      if (mode !== "bunny" || attempt >= maxAttempts) {
        process.exitCode = 1;
        return;
      }

      if (!retryableFailureClass(smokeResult.failureClass)) {
        process.exitCode = 1;
        return;
      }

      process.stdout.write(
        "Retrying once because failure class is retryable in Bunny mode.\n",
      );
      continue;
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
      const safeMessage = redactText(message, authKeys);
      process.stderr.write(`${safeMessage}\n`);

      if (attempt >= maxAttempts) {
        process.exitCode = 1;
        return;
      }

      if (mode !== "bunny") {
        process.exitCode = 1;
        return;
      }

      if (error instanceof TokenGuardError) {
        process.exitCode = 1;
        return;
      }

      if (
        /Room is required|Missing URL|required|Failed to query screening|BUNNY_TOKEN_AUTH_MODE/i.test(
          message,
        )
      ) {
        process.exitCode = 1;
        return;
      }

      process.exitCode = 1;
      return;
    }
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const authKeys = buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null);
    const message =
      error instanceof Error ? error.message : `Unknown error: ${String(error)}`;
    process.stderr.write(`${redactText(message, authKeys)}\n`);
    process.exitCode = 1;
  });
}
