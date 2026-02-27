export interface ChatMessage {
  id: string;
  room: string;
  nickname: string;
  avatarSeed: string;
  text: string;
  ts: number;
}

export function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.id === "string" &&
    typeof record.room === "string" &&
    typeof record.nickname === "string" &&
    typeof record.avatarSeed === "string" &&
    typeof record.text === "string" &&
    typeof record.ts === "number"
  );
}
