"use client";

import { useEffect, useRef } from "react";
import { avatarColorFromSeed, getInitials, identitySignature } from "@/lib/identity";
import type { ChatMessage } from "@/lib/chat/types";

type MessageListProps = {
  messages: ChatMessage[];
  currentUserSignature: string | null;
  onReport: (message: ChatMessage) => void;
  onMute: (message: ChatMessage) => void;
  onHostMute: (message: ChatMessage) => void;
  onHostRemove: (message: ChatMessage) => void;
  isHost: boolean;
};

function messageSignature(message: ChatMessage): string {
  return identitySignature({
    nickname: message.nickname,
    avatarSeed: message.avatarSeed,
  });
}

export default function MessageList({
  messages,
  currentUserSignature,
  onReport,
  onMute,
  onHostMute,
  onHostRemove,
  isHost,
}: MessageListProps) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="message-empty">
        Chat opens quietly.
        <br />
        Be the first to speak.
      </div>
    );
  }

  return (
    <ul className="message-list">
      {messages.map((message) => {
        const signature = messageSignature(message);
        const isSelf = currentUserSignature === signature;

        return (
          <li className="message-item" key={message.id}>
            <div
              className="message-avatar"
              style={{ backgroundColor: avatarColorFromSeed(message.avatarSeed) }}
              aria-hidden
            >
              {getInitials(message.nickname)}
            </div>
            <article className="message-body">
              <div className="message-meta">
                <span className="message-name">{message.nickname}</span>
                <span className="message-time">
                  {new Date(message.ts).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <p className="message-text">{message.text}</p>
              <div className="message-actions">
                <button
                  className="message-action"
                  type="button"
                  onClick={() => onReport(message)}
                >
                  Report
                </button>
                {!isSelf ? (
                  <button
                    className="message-action"
                    type="button"
                    onClick={() => onMute(message)}
                  >
                    Mute
                  </button>
                ) : null}
                {isHost && !isSelf ? (
                  <button
                    className="message-action"
                    type="button"
                    onClick={() => onHostMute(message)}
                  >
                    Host Mute
                  </button>
                ) : null}
                {isHost ? (
                  <button
                    className="message-action"
                    type="button"
                    onClick={() => onHostRemove(message)}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </article>
          </li>
        );
      })}
      <div ref={endRef} />
    </ul>
  );
}
