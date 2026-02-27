"use client";

import { useEffect, useMemo, useState } from "react";
import ChatPanel from "@/components/Chat/ChatPanel";
import Countdown from "@/components/Countdown";
import {
  computePremiereState,
  formatPremiereDateTime,
  type PremiereConfig,
  type PremiereState,
} from "@/lib/premiereConfig";
import { useMounted } from "@/lib/useMounted";

type PremiereShellProps = {
  room: string;
  config: PremiereConfig | null;
  initialNowMs: number;
};

function stateClassName(state: PremiereState): string {
  if (state === "WAITING") {
    return "state-waiting";
  }

  if (state === "LIVE") {
    return "state-live";
  }

  return "state-ended";
}

export default function PremiereShell({
  room,
  config,
  initialNowMs,
}: PremiereShellProps) {
  const mounted = useMounted();
  const [nowMs, setNowMs] = useState(initialNowMs);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  useEffect(() => {
    if (!mounted) {
      return;
    }

    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [mounted]);

  const state = useMemo<PremiereState | null>(() => {
    if (!config) {
      return null;
    }
    return computePremiereState(nowMs, config);
  }, [config, nowMs]);

  const canSend = Boolean(config && state !== "ENDED");
  const roomTitle = config ? config.title : `Room "${room}" not scheduled`;
  const stateLabel = state ?? "WAITING";
  const startLabel = config
    ? mounted
      ? formatPremiereDateTime(config.startAtIsoUtc)
      : "Resolving local time..."
    : null;
  const endLabel = config
    ? mounted
      ? formatPremiereDateTime(config.endAtIsoUtc)
      : "Resolving local time..."
    : null;

  return (
    <div className="premiere-page">
      <header className="premiere-header slide-in">
        <div>
          <p className="premiere-eyebrow">Live Cinema Premiere Room</p>
          <h1 className="premiere-title">{roomTitle}</h1>
          <p className="premiere-room">Room: {room}</p>
        </div>
        <div className="premiere-meta">
          {config ? (
            <>
              <span className={`state-badge ${stateClassName(stateLabel)}`}>
                {stateLabel}
              </span>
              {state === "WAITING" ? (
                <Countdown targetIsoUtc={config.startAtIsoUtc} label="Starts in" />
              ) : null}
              {state === "LIVE" ? (
                <Countdown targetIsoUtc={config.endAtIsoUtc} label="Ends in" />
              ) : null}
              <p className="premiere-time">Starts: {startLabel}</p>
              <p className="premiere-time">Ends: {endLabel}</p>
            </>
          ) : (
            <p className="premiere-time">No premiere config is scheduled yet.</p>
          )}
        </div>
      </header>

      <div className="premiere-main">
        <section className="video-panel slide-in">
          <h2 className="video-heading">Screen</h2>
          {!config ? (
            <div className="video-frame">
              <p className="video-state">
                This room has no active premiere config.
                <br />
                Try <strong>/premiere/demo</strong>.
              </p>
            </div>
          ) : state === "WAITING" ? (
            <div className="video-frame">
              <p className="video-state">
                Audience is assembling.
                <br />
                We open together at showtime.
              </p>
            </div>
          ) : state === "LIVE" ? (
            <div className="video-frame">
              <p className="video-state">
                Live now.
                <br />
                Week 1 placeholder panel for video player/embed.
              </p>
            </div>
          ) : (
            <div className="video-frame">
              <p className="video-state">
                Thanks for attending tonight&apos;s premiere.
                <br />
                The room is closed.
              </p>
              <a className="ended-link" href="#">
                Join discussion (stub)
              </a>
            </div>
          )}
        </section>

        <aside className={`chat-drawer ${mobileChatOpen ? "open" : ""}`}>
          <div className="chat-drawer-head">
            <h3 className="chat-drawer-title">Audience Chat</h3>
            <button
              className="chat-close-btn"
              type="button"
              onClick={() => setMobileChatOpen(false)}
            >
              Close
            </button>
          </div>
          <ChatPanel
            key={room}
            room={room}
            roomScheduled={Boolean(config)}
            canSend={canSend}
            slowModeSeconds={config?.slowModeSeconds ?? 60}
            maxMessageChars={config?.maxMessageChars ?? 320}
          />
        </aside>
      </div>

      {mobileChatOpen ? (
        <button
          className="chat-backdrop"
          type="button"
          aria-label="Close chat"
          onClick={() => setMobileChatOpen(false)}
        />
      ) : null}

      <button
        className="chat-toggle"
        type="button"
        onClick={() => setMobileChatOpen((current) => !current)}
      >
        Chat
      </button>
    </div>
  );
}
