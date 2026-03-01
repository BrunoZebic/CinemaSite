export type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const keyValue = token.slice(2);
    const [key, inlineValue] = keyValue.split("=", 2);
    if (!key) {
      continue;
    }

    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }

    flags[key] = next;
    i += 1;
  }

  return {
    positional,
    flags,
  };
}

export function getStringFlag(
  flags: Record<string, string | boolean>,
  key: string,
): string | null {
  const value = flags[key];
  if (typeof value !== "string") {
    return null;
  }
  return value.trim() || null;
}
