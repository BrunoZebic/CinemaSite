"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MessageList from "@/components/Chat/MessageList";
import Composer from "@/components/Chat/Composer";
import IdentityModal from "@/components/Identity/IdentityModal";
import { muteUser, getMutedUsers } from "@/lib/chat/moderation";
import {
  connectRoom,
  disconnectRoom,
  getChannelStatus,
  reconnectRoom,
  sendMessageBroadcast,
  sendModerationBroadcast,
  type ChannelHealthStatus,
} from "@/lib/chat/realtime";
import {
  getRemainingCooldownSeconds,
  registerSentMessage,
  validateMessageBeforeSend,
} from "@/lib/chat/rateLimit";
import type { ChatMessage, HostActionEvent } from "@/lib/chat/types";
import {
  getStoredIdentity,
  identitySignature,
  saveIdentity,
  type Identity,
} from "@/lib/identity";
import type { PremierePhase } from "@/lib/premiere/types";
import { hasSupabaseConfig } from "@/lib/supabaseClient";
import { useMounted } from "@/lib/useMounted";

const WATCHDOG_INTERVAL_MS = 30_000;

type ChatPanelProps = {
  room: string;
  roomScheduled: boolean;
  hasAccess: boolean;
  isHost: boolean;
  chatOpen: boolean;
  phase: PremierePhase;
  slowModeSeconds: number;
  maxMessageChars: number;
  onChannelHealthy?: () => Promise<void> | void;
  onChannelStatusChange?: (status: ChannelHealthStatus) => void;
};

function signatureForMessage(message: ChatMessage): string {
  return (
    message.signature ??
    identitySignature({
      nickname: message.nickname,
      avatarSeed: message.avatarSeed,
    })
  );
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

function friendlyChannelStatus(status: ChannelHealthStatus): string {
  if (status === "SUBSCRIBED") {
    return "Connected to room channel.";
  }
  if (status === "CHANNEL_ERROR") {
    return "Channel error. Reconnecting...";
  }
  if (status === "TIMED_OUT") {
    return "Realtime timed out. Reconnecting...";
  }
  if (status === "CLOSED") {
    return "Realtime closed. Reconnecting...";
  }
  return "Realtime disconnected.";
}

export default function ChatPanel({
  room,
  roomScheduled,
  hasAccess,
  isHost,
  chatOpen,
  phase,
  slowModeSeconds,
  maxMessageChars,
  onChannelHealthy,
  onChannelStatusChange,
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
  const [hostMutedSignatures, setHostMutedSignatures] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [removedMessageIds, setRemovedMessageIds] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [channelStatus, setChannelStatus] =
    useState<ChannelHealthStatus>("DISCONNECTED");
  const [reconnectAttempts, setReconnectAttempts] = useState(0);

  const reconnectingRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const realtimeConfigured = hasSupabaseConfig();

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

  const currentUserSignature = identity ? identitySignature(identity) : null;
  const mutedUsersRef = useRef(mutedUsers);
  const hostMutedRef = useRef(hostMutedSignatures);
  const removedMessageIdsRef = useRef(removedMessageIds);

  useEffect(() => {
    mutedUsersRef.current = mutedUsers;
  }, [mutedUsers]);

  useEffect(() => {
    hostMutedRef.current = hostMutedSignatures;
  }, [hostMutedSignatures]);

  useEffect(() => {
    removedMessageIdsRef.current = removedMessageIds;
  }, [removedMessageIds]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const applyModerationEvent = useCallback((event: HostActionEvent) => {
    if (event.actionType === "mute_signature" && event.targetSignature) {
      setHostMutedSignatures((current) => {
        const next = new Set(current);
        next.add(event.targetSignature as string);
        return next;
      });
      return;
    }

    if (event.actionType === "unmute_signature" && event.targetSignature) {
      setHostMutedSignatures((current) => {
        const next = new Set(current);
        next.delete(event.targetSignature as string);
        return next;
      });
      return;
    }

    if (event.actionType === "remove_message" && event.targetMessageId) {
      setRemovedMessageIds((current) => {
        const next = new Set(current);
        next.add(event.targetMessageId as string);
        return next;
      });
    }
  }, []);

  const reconnectWithBackoff = useCallback(async () => {
    if (reconnectingRef.current) {
      return;
    }

    reconnectingRef.current = true;
    try {
      const attempt = reconnectAttemptsRef.current;
      const delayMs = Math.min(30_000, Math.max(1000, 2 ** attempt * 1000));
      if (attempt > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      }

      reconnectAttemptsRef.current += 1;
      setReconnectAttempts(reconnectAttemptsRef.current);
      reconnectRoom();
    } finally {
      reconnectingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!mounted || !roomScheduled || !hasAccess || !realtimeConfigured) {
      disconnectRoom();
      return;
    }

    connectRoom({
      room,
      onMessage: (incoming) => {
        if (incoming.room !== room) {
          return;
        }

        const signature = signatureForMessage(incoming);
        if (
          mutedUsersRef.current.has(signature) ||
          hostMutedRef.current.has(signature) ||
          removedMessageIdsRef.current.has(incoming.id)
        ) {
          return;
        }

        setMessages((current) => appendUniqueMessage(current, incoming));
      },
      onModeration: (event) => {
        if (event.room !== room) {
          return;
        }
        applyModerationEvent(event);
      },
      onStatusChange: (status) => {
        setChannelStatus(status);
        onChannelStatusChange?.(status);
      },
      onHealthy: () => {
        reconnectAttemptsRef.current = 0;
        setReconnectAttempts(0);
        void onChannelHealthy?.();
      },
    });

    return () => {
      disconnectRoom();
    };
  }, [
    applyModerationEvent,
    hasAccess,
    mounted,
    onChannelHealthy,
    onChannelStatusChange,
    realtimeConfigured,
    room,
    roomScheduled,
  ]);

  useEffect(() => {
    if (!mounted || !roomScheduled || !hasAccess || !realtimeConfigured) {
      return;
    }

    let cancelled = false;
    const loadMessages = async () => {
      try {
        const response = await fetch(`/api/rooms/${room}/messages?limit=100`, {
          cache: "no-store",
        });
        if (!response.ok || cancelled) {
          return;
        }

        const payload = (await response.json()) as {
          messages?: ChatMessage[];
        };
        const nextMessages = Array.isArray(payload.messages)
          ? payload.messages
          : [];
        setMessages(nextMessages);
      } catch (error) {
        console.error(error);
      }
    };

    void loadMessages();
    return () => {
      cancelled = true;
    };
  }, [hasAccess, mounted, realtimeConfigured, room, roomScheduled]);

  useEffect(() => {
    if (!mounted || !roomScheduled || !hasAccess || !realtimeConfigured) {
      return;
    }

    const timer = window.setInterval(() => {
      const status = getChannelStatus();
      if (status !== "SUBSCRIBED") {
        void reconnectWithBackoff();
      }
    }, WATCHDOG_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [hasAccess, mounted, realtimeConfigured, reconnectWithBackoff, roomScheduled]);

  const cooldownSeconds = useMemo(() => {
    if (!currentUserSignature) {
      return 0;
    }

    return getRemainingCooldownSeconds(room, slowModeSeconds, clockMs);
  }, [clockMs, currentUserSignature, room, slowModeSeconds]);

  const visibleMessages = useMemo(
    () =>
      messages.filter((message) => {
        const signature = signatureForMessage(message);
        return (
          !mutedUsers.has(signature) &&
          !hostMutedSignatures.has(signature) &&
          !removedMessageIds.has(message.id)
        );
      }),
    [hostMutedSignatures, messages, mutedUsers, removedMessageIds],
  );

  const composerDisabled =
    !mounted ||
    !identity ||
    !roomScheduled ||
    !hasAccess ||
    !chatOpen ||
    !realtimeConfigured;

  const connectionInfo = !mounted
    ? "Loading audience profile..."
    : !roomScheduled
      ? "Room not scheduled yet."
      : !hasAccess
        ? "Invite code required."
        : !realtimeConfigured
          ? "Realtime disabled. Add Supabase env vars."
          : reconnectAttempts > 0
            ? `${friendlyChannelStatus(channelStatus)} Retry #${reconnectAttempts}`
            : friendlyChannelStatus(channelStatus);

  const composerHelpText = !identity
    ? "Choose a nickname to chat."
    : !hasAccess
      ? "Invite code required."
      : !chatOpen
        ? phase === "SILENCE"
          ? "Chat is locked during silence."
          : "Chat is closed."
        : notice;

  async function handleSend(rawText: string): Promise<void> {
    if (!identity) {
      setNotice("Pick a nickname first.");
      return;
    }

    if (!roomScheduled || !hasAccess) {
      setNotice("Invite access required.");
      return;
    }

    if (!chatOpen) {
      setNotice("Chat is locked in this phase.");
      return;
    }

    const signature = identitySignature(identity);
    const validation = validateMessageBeforeSend({
      room,
      senderSignature: signature,
      text: rawText,
      slowModeSeconds,
      maxMessageChars,
    });

    if (!validation.ok) {
      setNotice(validation.message);
      setClockMs(Date.now());
      return;
    }

    const messageId = createMessageId();
    const response = await fetch(`/api/rooms/${room}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: messageId,
        nickname: identity.nickname,
        avatarSeed: identity.avatarSeed,
        signature,
        text: validation.normalizedText,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setNotice(payload?.error ?? "Message rejected.");
      return;
    }

    const payload = (await response.json()) as {
      message?: ChatMessage;
    };
    const persistedMessage = payload.message;
    if (!persistedMessage) {
      setNotice("Message was not accepted.");
      return;
    }

    registerSentMessage({
      room,
      senderSignature: signature,
      normalizedText: persistedMessage.text,
      nowMs: persistedMessage.ts,
    });

    setClockMs(persistedMessage.ts);
    setMessages((current) => appendUniqueMessage(current, persistedMessage));

    try {
      await sendMessageBroadcast(room, persistedMessage);
    } catch (error) {
      console.error(error);
      setNotice("Message saved, but realtime broadcast failed.");
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

  async function handleHostMute(message: ChatMessage): Promise<void> {
    if (!isHost) {
      return;
    }

    const targetSignature = signatureForMessage(message);
    const response = await fetch(`/api/rooms/${room}/host-actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actionType: "mute_signature",
        targetSignature,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setNotice(payload?.error ?? "Host mute failed.");
      return;
    }

    const payload = (await response.json()) as { event?: HostActionEvent };
    if (!payload.event) {
      setNotice("Host mute failed.");
      return;
    }

    applyModerationEvent(payload.event);
    try {
      await sendModerationBroadcast(room, payload.event);
    } catch (error) {
      console.error(error);
    }
    setNotice(`Host muted ${message.nickname}.`);
  }

  async function handleHostRemove(message: ChatMessage): Promise<void> {
    if (!isHost) {
      return;
    }

    const response = await fetch(`/api/rooms/${room}/host-actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        actionType: "remove_message",
        targetMessageId: message.id,
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setNotice(payload?.error ?? "Remove action failed.");
      return;
    }

    const payload = (await response.json()) as { event?: HostActionEvent };
    if (!payload.event) {
      setNotice("Remove action failed.");
      return;
    }

    applyModerationEvent(payload.event);
    try {
      await sendModerationBroadcast(room, payload.event);
    } catch (error) {
      console.error(error);
    }
    setNotice("Message removed by host.");
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
      <p className="chat-status">{connectionInfo}</p>
      {notice ? <p className="chat-status warn">{notice}</p> : null}
      <MessageList
        messages={visibleMessages}
        currentUserSignature={currentUserSignature}
        onReport={handleReport}
        onMute={handleMute}
        onHostMute={(message) => {
          void handleHostMute(message);
        }}
        onHostRemove={(message) => {
          void handleHostRemove(message);
        }}
        isHost={isHost}
      />
      <Composer
        disabled={composerDisabled}
        cooldownSeconds={cooldownSeconds}
        maxChars={maxMessageChars}
        helperText={composerHelpText}
        onSend={handleSend}
      />
      <IdentityModal
        open={mounted && hasAccess && !identity}
        onSave={handleIdentitySave}
      />
    </section>
  );
}
