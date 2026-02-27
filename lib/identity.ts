const IDENTITY_STORAGE_KEY = "premiere.identity.v1";
const NICKNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,19}$/;

export interface Identity {
  nickname: string;
  avatarSeed: string;
  createdAt: number;
}

function hasWindow() {
  return typeof window !== "undefined";
}

function createSeed(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function normalizeNickname(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

export function isValidNickname(input: string): boolean {
  const nickname = normalizeNickname(input);
  return NICKNAME_PATTERN.test(nickname);
}

export function createIdentity(nicknameInput: string): Identity {
  const nickname = normalizeNickname(nicknameInput);
  if (!isValidNickname(nickname)) {
    throw new Error("Nickname must be 2-20 chars and use letters, numbers, space, - or _.");
  }

  return {
    nickname,
    avatarSeed: createSeed(),
    createdAt: Date.now(),
  };
}

export function getStoredIdentity(): Identity | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<Identity>;
    if (
      typeof parsed.nickname !== "string" ||
      !isValidNickname(parsed.nickname) ||
      typeof parsed.avatarSeed !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }

    return {
      nickname: normalizeNickname(parsed.nickname),
      avatarSeed: parsed.avatarSeed,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function saveIdentity(identity: Identity): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
}

export function clearIdentity(): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.removeItem(IDENTITY_STORAGE_KEY);
}

export function getInitials(nickname: string): string {
  const words = normalizeNickname(nickname).split(" ");

  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }

  return `${words[0][0] ?? ""}${words[1][0] ?? ""}`.toUpperCase();
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function avatarColorFromSeed(seed: string): string {
  const hue = hashString(seed) % 360;
  return `hsl(${hue} 62% 45%)`;
}

export function identitySignature(
  user: Pick<Identity, "nickname" | "avatarSeed">,
): string {
  return `${normalizeNickname(user.nickname).toLowerCase()}::${user.avatarSeed}`;
}
