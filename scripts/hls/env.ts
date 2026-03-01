import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ENV_FILE_NAMES = [".env.local", ".env"];

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseAndApplyEnvFile(filePath: string): void {
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    const rawValue = line.slice(equalsIndex + 1);
    process.env[key] = unquote(rawValue);
  }
}

export function loadLocalEnv(rootDir: string = process.cwd()): void {
  for (const fileName of ENV_FILE_NAMES) {
    const filePath = path.resolve(rootDir, fileName);
    if (!existsSync(filePath)) {
      continue;
    }
    parseAndApplyEnvFile(filePath);
  }
}
