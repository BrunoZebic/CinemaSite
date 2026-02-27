"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MessageList from "@/components/Chat/MessageList";
import Composer from "@/components/Chat/Composer";
import IdentityModal from "@/components/Identity/IdentityModal";
import { muteUser, getMutedUsers } from "@/lib/chat/moderation";
import { connectRoom, disconnectRoom, sendMessage } from "@/lib/chat/realtime";
import {
  getRemainingCooldownSeconds,
  registerSentMessage,
  validateMessageBeforeSend,
} from "@/lib/chat/rateLimit";
import type { ChatMessage } from "@/lib/chat/types";
import {
  getStoredIdentity,
  identitySignature,
  saveIdentity,
  type Identity,
} from "@/lib/identity";
import { hasSupabaseConfig } from "@/lib/supabaseClient";
import { useMounted } from "@/lib/useMounted";

type ChatPanelProps = {
  room: string;
  roomScheduled: boolean;
  canSend: boolean;
  slowModeSeconds: number;
  maxMessageChars: number;
};

function signatureForMessage(message: ChatMessage): string {
  return identitySignature({
    nickname: message.nickname,
    avatarSeed: message.avatarSeed,
  });
}

function appendUniqueMessage(
  current: ChatMessage[],
  incoming: ChatMessage,
): ChatMessage[] {
  if (current.some((message) => message.id === incoming.id)) {
    return current;
  }

  return [...current, incoming].sort((a, b) => a.ts - b.ts);
}

function createMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function ChatPanel({
  room,
  roomScheduled,
  canSend,
  slowModeSeconds,
  maxMessageChars,
}: ChatPanelProps) {
  const mounted = useMounted();
  const [identityOverride, setIdentityOverride] = useState<Identity | null>(
    null,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [sessionMutedUsers, setSessionMutedUsers] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [clockMs, setClockMs] = useState(() => Date.now());

  const storedIdentity = useMemo(
    () => (mounted ? getStoredIdentity() : null),
    [mounted],
  );
  const identity = identityOverride ?? storedIdentity;

  const storedMutedUsers = useMemo(
    () => (mounted ? getMutedUsers() : new Set<string>()),
    [mounted],
  );

  const mutedUsers = useMemo(() => {
    const combined = new Set(storedMutedUsers);
    for (const muted of sessionMutedUsers) {
      combined.add(muted);
    }
    return combined;
  }, [storedMutedUsers, sessionMutedUsers]);

  const realtimeConfigured = hasSupabaseConfig();
  const currentUserSignature = identity ? identitySignature(identity) : null;
  const mutedUsersRef = useRef(mutedUsers);

  useEffect(() => {
    mutedUsersRef.current = mutedUsers;
  }, [mutedUsers]);

  useEffect(() => {
    if (!roomScheduled) {
      disconnectRoom();
      return;
    }

    if (!realtimeConfigured) {
      disconnectRoom();
      return;
    }

    connectRoom(room, (incoming) => {
      if (incoming.room !== room) {
        return;
      }

      const signature = signatureForMessage(incoming);
      if (mutedUsersRef.current.has(signature)) {
        return;
      }

      setMessages((current) => appendUniqueMessage(current, incoming));
    });

    return () => {
      disconnectRoom();
    };
  }, [room, roomScheduled, realtimeConfigured]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const cooldownSeconds = useMemo(() => {
    if (!currentUserSignature) {
      return 0;
    }

    return getRemainingCooldownSeconds(room, slowModeSeconds, clockMs);
  }, [currentUserSignature, room, slowModeSeconds, clockMs]);

  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) => !mutedUsers.has(signatureForMessage(message)),
      ),
    [messages, mutedUsers],
  );

  const composerDisabled =
    !mounted || !identity || !roomScheduled || !canSend || !realtimeConfigured;

  const connectionInfo = !mounted
    ? "Loading audience profile..."
    : !roomScheduled
    ? "Room not scheduled yet."
    : !realtimeConfigured
      ? "Realtime disabled. Add Supabase env vars."
      : "Connected to live channel.";

  const composerHelpText = !identity
    ? "Choose a nickname to chat."
    : !roomScheduled
      ? "Room not scheduled."
      : !realtimeConfigured
        ? "Supabase env vars are missing."
        : !canSend
          ? "Premiere ended. Chat is closed."
          : notice;

  async function handleSend(rawText: string): Promise<void> {
    if (!identity) {
      setNotice("Pick a nickname first.");
      return;
    }

    if (!roomScheduled) {
      setNotice("Room not scheduled.");
      return;
    }

    if (!realtimeConfigured) {
      setNotice("Missing Supabase env vars.");
      return;
    }

    if (!canSend) {
      setNotice("Premiere ended. Chat is closed.");
      return;
    }

    const validation = validateMessageBeforeSend({
      room,
      senderSignature: identitySignature(identity),
      text: rawText,
      slowModeSeconds,
      maxMessageChars,
    });

    if (!validation.ok) {
      setNotice(validation.message);
      setClockMs(Date.now());
      return;
    }

    const outgoing: ChatMessage = {
      id: createMessageId(),
      room,
      nickname: identity.nickname,
      avatarSeed: identity.avatarSeed,
      text: validation.normalizedText,
      ts: Date.now(),
    };

    registerSentMessage({
      room,
      senderSignature: identitySignature(identity),
      normalizedText: validation.normalizedText,
      nowMs: outgoing.ts,
    });

    setClockMs(outgoing.ts);
    setMessages((current) => appendUniqueMessage(current, outgoing));

    try {
      await sendMessage(room, outgoing);
      setNotice(null);
    } catch (error) {
      console.error(error);
      setNotice("Message delivery failed.");
      setMessages((current) =>
        current.filter((message) => message.id !== outgoing.id),
      );
    }
  }

  function handleIdentitySave(nextIdentity: Identity): void {
    saveIdentity(nextIdentity);
    setIdentityOverride(nextIdentity);
    setNotice(null);
  }

  function handleReport(message: ChatMessage): void {
    setNotice(`Report queued for ${message.nickname} (placeholder).`);
  }

  function handleMute(message: ChatMessage): void {
    const signature = signatureForMessage(message);
    if (signature === currentUserSignature) {
      setNotice("You cannot mute yourself.");
      return;
    }

    muteUser(signature);
    setSessionMutedUsers((current) => {
      const next = new Set(current);
      next.add(signature);
      return next;
    });
    setNotice(`Muted ${message.nickname} on this device.`);
  }

  return (
    <section className="chat-panel">
      <div className="chat-topline">
        <div className="identity-pill">
          <span className="identity-dot" aria-hidden />
          {mounted && identity
            ? `You are: ${identity.nickname}`
            : "Identity required"}
        </div>
        <p className="philosophy-note">
          No emails. No tracking. Just cinema together.
        </p>
      </div>
      {connectionInfo ? (
        <p className="chat-status">{connectionInfo}</p>
      ) : null}
      {notice ? <p className="chat-status warn">{notice}</p> : null}
      <MessageList
        messages={visibleMessages}
        currentUserSignature={currentUserSignature}
        onReport={handleReport}
        onMute={handleMute}
      />
      <Composer
        disabled={composerDisabled}
        cooldownSeconds={cooldownSeconds}
        maxChars={maxMessageChars}
        helperText={composerHelpText}
        onSend={handleSend}
      />
      <IdentityModal open={mounted && !identity} onSave={handleIdentitySave} />
    </section>
  );
}
