import type { PremierePhase } from "@/lib/premiere/types";

export interface ChatMessage {
  id: string;
  room: string;
  nickname: string;
  avatarSeed: string;
  text: string;
  ts: number;
  phase?: PremierePhase;
  signature?: string;
}

export type HostActionType = "mute_signature" | "unmute_signature" | "remove_message";

export interface HostActionEvent {
  id: string;
  room: string;
  actionType: HostActionType;
  targetSignature?: string;
  targetMessageId?: string;
  ts: number;
  actor: "host";
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

export function isHostActionEvent(value: unknown): value is HostActionEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  const actionType = record.actionType;
  if (
    actionType !== "mute_signature" &&
    actionType !== "unmute_signature" &&
    actionType !== "remove_message"
  ) {
    return false;
  }

  return (
    typeof record.id === "string" &&
    typeof record.room === "string" &&
    typeof record.ts === "number" &&
    record.actor === "host"
  );
}
