const MUTED_USERS_KEY = "premiere.muted.v1";

function hasWindow() {
  return typeof window !== "undefined";
}

function saveMutedSet(next: Set<string>): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(MUTED_USERS_KEY, JSON.stringify([...next]));
}

export function getMutedUsers(): Set<string> {
  if (!hasWindow()) {
    return new Set<string>();
  }

  try {
    const raw = window.localStorage.getItem(MUTED_USERS_KEY);
    if (!raw) {
      return new Set<string>();
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }

    return new Set(
      parsed.filter((entry): entry is string => typeof entry === "string"),
    );
  } catch {
    return new Set<string>();
  }
}

export function muteUser(signature: string): Set<string> {
  const next = getMutedUsers();
  next.add(signature);
  saveMutedSet(next);
  return next;
}

export function unmuteUser(signature: string): Set<string> {
  const next = getMutedUsers();
  next.delete(signature);
  saveMutedSet(next);
  return next;
}
