"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { avatarColorFromSeed, getInitials, identitySignature } from "@/lib/identity";
import type { ChatMessage } from "@/lib/chat/types";

const BOTTOM_THRESHOLD_PX = 48;

type MessageListProps = {
  messages: ChatMessage[];
  currentUserSignature: string | null;
  onReport: (message: ChatMessage) => void;
  onMute: (message: ChatMessage) => void;
  onHostMute: (message: ChatMessage) => void;
  onHostRemove: (message: ChatMessage) => void;
  isHost: boolean;
};

type ActionIconKind = "report" | "mute" | "hostMute" | "remove";

function messageSignature(message: ChatMessage): string {
  return identitySignature({
    nickname: message.nickname,
    avatarSeed: message.avatarSeed,
  });
}

function ActionIcon({ kind }: { kind: ActionIconKind }) {
  if (kind === "report") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M6 3h10l-1 4 1 4H8v10H6V3Zm2 2v4h5.4l-.5-2 .5-2H8Z"
        />
      </svg>
    );
  }

  if (kind === "mute") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M14 5 9 9H5v6h4l5 4V5Zm5.7 3.3-1.4 1.4L20.6 12l-2.3 2.3 1.4 1.4 2.3-2.3 2.3 2.3 1.4-1.4-2.3-2.3 2.3-2.3-1.4-1.4-2.3 2.3-2.3-2.3Z"
        />
      </svg>
    );
  }

  if (kind === "hostMute") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M12 2 4 5v6c0 5 3.4 9.7 8 11 4.6-1.3 8-6 8-11V5l-8-3Zm0 2.2 6 2.2v4.6c0 4-2.6 7.9-6 9-3.4-1.1-6-5-6-9V6.4l6-2.2Zm-2.7 4.5L8 10l2.1 2.1L8 14.2l1.3 1.3 2.1-2.1 2.1 2.1 1.3-1.3-2.1-2.1 2.1-2.1-1.3-1.3-2.1 2.1L9.3 8.7Z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 6h2v8h-2V9Zm4 0h2v8h-2V9ZM6 9h2v8H6V9Zm1 12h10a2 2 0 0 0 2-2V8H5v11a2 2 0 0 0 2 2Z"
      />
    </svg>
  );
}

function isNearBottom(listElement: HTMLUListElement): boolean {
  const distance =
    listElement.scrollHeight - listElement.scrollTop - listElement.clientHeight;
  return distance <= BOTTOM_THRESHOLD_PX;
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
  const listRef = useRef<HTMLUListElement | null>(null);
  const bottomRef = useRef<HTMLLIElement | null>(null);
  const hasInitialAutoScrollDoneRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const userPinnedToBottomRef = useRef(true);
  const [userPinnedToBottom, setUserPinnedToBottom] = useState(true);
  const [isNearBottomState, setIsNearBottomState] = useState(true);
  const [pendingNewCount, setPendingNewCount] = useState(0);

  useEffect(() => {
    userPinnedToBottomRef.current = userPinnedToBottom;
  }, [userPinnedToBottom]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    bottomRef.current?.scrollIntoView({
      behavior,
      block: "end",
    });
  }, []);

  const evaluateNearBottom = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return true;
    }

    return isNearBottom(listElement);
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const previousCount = previousMessageCountRef.current;
      const addedCount = Math.max(0, messages.length - previousCount);
      previousMessageCountRef.current = messages.length;

      if (messages.length === 0) {
        hasInitialAutoScrollDoneRef.current = false;
        setUserPinnedToBottom(true);
        setIsNearBottomState(true);
        setPendingNewCount(0);
        return;
      }

      if (!hasInitialAutoScrollDoneRef.current) {
        hasInitialAutoScrollDoneRef.current = true;
        scrollToBottom("auto");
        setUserPinnedToBottom(true);
        setIsNearBottomState(true);
        setPendingNewCount(0);
        return;
      }

      if (userPinnedToBottomRef.current) {
        scrollToBottom("smooth");
        setIsNearBottomState(true);
        setPendingNewCount(0);
        return;
      }

      if (addedCount > 0) {
        setPendingNewCount((current) => current + addedCount);
      }

      const nearBottom = evaluateNearBottom();
      setIsNearBottomState((current) =>
        current === nearBottom ? current : nearBottom,
      );
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [evaluateNearBottom, messages.length, scrollToBottom]);

  useEffect(() => {
    const listElement = listRef.current;
    if (!listElement || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      const nearBottom = evaluateNearBottom();
      setIsNearBottomState((current) =>
        current === nearBottom ? current : nearBottom,
      );

      if (userPinnedToBottomRef.current) {
        scrollToBottom("auto");
        setPendingNewCount(0);
      }
    });

    observer.observe(listElement);
    return () => {
      observer.disconnect();
    };
  }, [evaluateNearBottom, scrollToBottom]);

  const handleListScroll = useCallback(() => {
    const nearBottom = evaluateNearBottom();
    setIsNearBottomState((current) => (current === nearBottom ? current : nearBottom));

    if (nearBottom) {
      setUserPinnedToBottom((current) => (current ? current : true));
      setPendingNewCount((current) => (current === 0 ? current : 0));
      return;
    }

    setUserPinnedToBottom((current) => (current ? false : current));
  }, [evaluateNearBottom]);

  const handleJumpToLatest = useCallback(() => {
    scrollToBottom("smooth");
    setUserPinnedToBottom(true);
    setIsNearBottomState(true);
    setPendingNewCount(0);
  }, [scrollToBottom]);

  if (messages.length === 0) {
    return (
      <div className="message-list-shell">
        <div className="message-empty">
          Chat opens quietly.
          <br />
          Be the first to speak.
        </div>
      </div>
    );
  }

  return (
    <div className="message-list-shell">
      <ul className="message-list" ref={listRef} onScroll={handleListScroll}>
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
                  <div className="message-meta-right">
                    <span className="message-time">
                      {new Date(message.ts).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <div className="message-actions-inline" role="group">
                      <button
                        className="message-action-icon"
                        type="button"
                        onClick={() => onReport(message)}
                        aria-label={`Report message from ${message.nickname}`}
                        title="Report"
                      >
                        <ActionIcon kind="report" />
                      </button>
                      {!isSelf ? (
                        <button
                          className="message-action-icon"
                          type="button"
                          onClick={() => onMute(message)}
                          aria-label={`Mute ${message.nickname}`}
                          title="Mute"
                        >
                          <ActionIcon kind="mute" />
                        </button>
                      ) : null}
                      {isHost && !isSelf ? (
                        <button
                          className="message-action-icon"
                          type="button"
                          onClick={() => onHostMute(message)}
                          aria-label={`Host mute ${message.nickname}`}
                          title="Host Mute"
                        >
                          <ActionIcon kind="hostMute" />
                        </button>
                      ) : null}
                      {isHost ? (
                        <button
                          className="message-action-icon danger"
                          type="button"
                          onClick={() => onHostRemove(message)}
                          aria-label="Remove message"
                          title="Remove"
                        >
                          <ActionIcon kind="remove" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <p className="message-text">{message.text}</p>
              </article>
            </li>
          );
        })}
        <li className="message-bottom-anchor" ref={bottomRef} aria-hidden />
      </ul>
      {pendingNewCount > 0 && !isNearBottomState ? (
        <button
          className="message-jump-latest"
          type="button"
          onClick={handleJumpToLatest}
        >
          Jump to latest (+{pendingNewCount})
        </button>
      ) : null}
    </div>
  );
}
