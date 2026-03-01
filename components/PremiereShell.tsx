"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InviteGateModal from "@/components/Access/InviteGateModal";
import HostAuthInline from "@/components/Access/HostAuthInline";
import ChatPanel from "@/components/Chat/ChatPanel";
import Countdown from "@/components/Countdown";
import HlsSyncPlayer from "@/components/Video/HlsSyncPlayer";
import VideoSyncPlayer from "@/components/Video/VideoSyncPlayer";
import type {
  VideoSyncDebugState,
  VideoSyncPlayerHandle,
} from "@/components/Video/types";
import {
  computePremierePhase,
  getPhaseEndsAtUnixMs,
  isChatOpenForPhase,
} from "@/lib/premiere/phase";
import type { PremierePhase, RoomBootstrap } from "@/lib/premiere/types";
import { formatUnixDateTime } from "@/lib/premiereConfig";
import type { ChannelHealthStatus } from "@/lib/chat/realtime";
import { useMounted } from "@/lib/useMounted";

type PremiereShellProps = {
  room: string;
  initialBootstrap: RoomBootstrap;
};

const syncDebugEnabled = process.env.NEXT_PUBLIC_SYNC_DEBUG === "true";

function stateClassName(state: PremierePhase): string {
  if (state === "WAITING") {
    return "state-waiting";
  }

  if (state === "LIVE" || state === "DISCUSSION") {
    return "state-live";
  }

  return "state-ended";
}

function countdownLabelForPhase(phase: PremierePhase): string | null {
  if (phase === "WAITING") {
    return "Starts in";
  }
  if (phase === "LIVE") {
    return "Silence in";
  }
  if (phase === "SILENCE") {
    return "Discussion opens in";
  }
  if (phase === "DISCUSSION") {
    return "Room closes in";
  }
  return null;
}

export default function PremiereShell({ room, initialBootstrap }: PremiereShellProps) {
  const mounted = useMounted();
  const videoRef = useRef<VideoSyncPlayerHandle | null>(null);
  const reconnectAtomicRef = useRef(false);
  const [bootstrap, setBootstrap] = useState(initialBootstrap);
  const [serverOffsetMs, setServerOffsetMs] = useState(
    initialBootstrap.serverNowUnixMs - Date.now(),
  );
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [syncDebugState, setSyncDebugState] = useState<VideoSyncDebugState | null>(
    null,
  );
  const [channelStatus, setChannelStatus] =
    useState<ChannelHealthStatus>("DISCONNECTED");

  const screening = bootstrap.screening;
  const phase = useMemo<PremierePhase>(() => {
    if (!screening) {
      return "WAITING";
    }
    return computePremierePhase(clockMs + serverOffsetMs, screening);
  }, [clockMs, screening, serverOffsetMs]);

  const hasAccess = bootstrap.hasAccess;
  const isHost = bootstrap.isHost;
  const chatOpen = Boolean(screening && hasAccess && isChatOpenForPhase(phase));
  const useHlsPlayer = screening?.videoProvider === "hls";

  const refreshBootstrap = useCallback(async (): Promise<RoomBootstrap | null> => {
    const response = await fetch(`/api/rooms/${room}/bootstrap`, {
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as RoomBootstrap;
    setBootstrap(payload);
    setServerOffsetMs(payload.serverNowUnixMs - Date.now());
    return payload;
  }, [room]);

  const refreshServerTime = useCallback(async () => {
    const response = await fetch("/api/time", {
      cache: "no-store",
    });
    if (!response.ok) {
      return;
    }
    const payload = (await response.json()) as { serverNowUnixMs?: number };
    if (typeof payload.serverNowUnixMs !== "number") {
      return;
    }
    setServerOffsetMs(payload.serverNowUnixMs - Date.now());
  }, []);

  const handleChannelHealthy = useCallback(async () => {
    if (reconnectAtomicRef.current) {
      return;
    }

    reconnectAtomicRef.current = true;
    try {
      await refreshBootstrap();
      await videoRef.current?.resyncToCanonicalTime();
    } finally {
      reconnectAtomicRef.current = false;
    }
  }, [refreshBootstrap]);

  const handleDebugStateChange = useCallback((next: VideoSyncDebugState) => {
    setSyncDebugState((current) => {
      if (
        current &&
        current.phase === next.phase &&
        current.playerTime === next.playerTime &&
        current.targetTime === next.targetTime &&
        current.drift === next.drift &&
        current.isDriftLoopActive === next.isDriftLoopActive &&
        current.serverOffsetMs === next.serverOffsetMs &&
        current.lastResyncAt === next.lastResyncAt &&
        current.channelStatus === next.channelStatus &&
        current.readyState === next.readyState &&
        current.buffering === next.buffering &&
        current.readinessStage === next.readinessStage &&
        current.recoveryState === next.recoveryState &&
        current.recoveryAttemptsWindow === next.recoveryAttemptsWindow &&
        current.lastErrorClass === next.lastErrorClass &&
        current.playbackStartState === next.playbackStartState &&
        current.autoplayBlocked === next.autoplayBlocked &&
        current.playIntentActive === next.playIntentActive
      ) {
        return current;
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClockMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!mounted) {
      return;
    }

    void refreshServerTime();
    const timer = window.setInterval(() => {
      void refreshServerTime();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [mounted, refreshServerTime]);

  const roomTitle = screening ? screening.title : `Room "${room}" not scheduled`;
  const countdownTarget = screening ? getPhaseEndsAtUnixMs(phase, screening) : null;
  const countdownLabel = countdownLabelForPhase(phase);

  return (
    <div className="premiere-page">
      <header className="premiere-header slide-in">
        <div>
          <p className="premiere-eyebrow">Live Cinema Premiere Room</p>
          <h1 className="premiere-title">{roomTitle}</h1>
          <p className="premiere-room">Room: {room}</p>
        </div>
        <div className="premiere-meta">
          {screening ? (
            <>
              <span className={`state-badge ${stateClassName(phase)}`}>{phase}</span>
              {countdownTarget && countdownLabel ? (
                <Countdown targetUnixMs={countdownTarget} label={countdownLabel} />
              ) : null}
              <p className="premiere-time">
                Starts:{" "}
                {mounted
                  ? formatUnixDateTime(screening.premiereStartUnixMs)
                  : "Resolving local time..."}
              </p>
              <HostAuthInline
                room={room}
                isHost={isHost}
                onSuccess={() => {
                  void refreshBootstrap();
                }}
              />
            </>
          ) : (
            <p className="premiere-time">No screening is scheduled yet.</p>
          )}
        </div>
      </header>

      <div className="premiere-main">
        <section className="video-panel slide-in">
          {useHlsPlayer ? (
            <HlsSyncPlayer
              ref={videoRef}
              room={room}
              screening={screening}
              phase={phase}
              hasAccess={hasAccess}
              serverOffsetMs={serverOffsetMs}
              channelStatus={channelStatus}
              finalManifestUrl={bootstrap.finalManifestUrl}
              tokenExpiresAtUnixMs={bootstrap.tokenExpiresAtUnixMs}
              requiresPriming={bootstrap.requiresPriming}
              playbackConfigError={bootstrap.playbackConfigError}
              rehearsalScrubEnabled={bootstrap.rehearsalScrubEnabled}
              onBootstrapRefresh={refreshBootstrap}
              onDebugStateChange={handleDebugStateChange}
            />
          ) : (
            <VideoSyncPlayer
              ref={videoRef}
              room={room}
              screening={screening}
              phase={phase}
              hasAccess={hasAccess}
              serverOffsetMs={serverOffsetMs}
              channelStatus={channelStatus}
              onDebugStateChange={handleDebugStateChange}
            />
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
            key={`${room}:${hasAccess ? "access" : "locked"}`}
            room={room}
            roomScheduled={Boolean(screening)}
            hasAccess={hasAccess}
            isHost={isHost}
            chatOpen={chatOpen}
            phase={phase}
            slowModeSeconds={screening?.slowModeSeconds ?? 60}
            maxMessageChars={screening?.maxMessageChars ?? 320}
            onChannelHealthy={handleChannelHealthy}
            onChannelStatusChange={setChannelStatus}
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

      <InviteGateModal
        open={mounted && Boolean(screening) && !hasAccess}
        room={room}
        onSuccess={() => {
          void refreshBootstrap();
        }}
      />

      {syncDebugEnabled && syncDebugState ? (
        <aside className="sync-debug-panel">
          <p className="sync-debug-title">Sync Debug</p>
          <p>phase: {syncDebugState.phase}</p>
          <p>playerTime: {syncDebugState.playerTime.toFixed(2)}</p>
          <p>targetTime: {syncDebugState.targetTime.toFixed(2)}</p>
          <p>drift: {syncDebugState.drift.toFixed(3)}</p>
          <p>channelStatus: {syncDebugState.channelStatus}</p>
          <p>isDriftLoopActive: {String(syncDebugState.isDriftLoopActive)}</p>
          <p>serverOffsetMs: {Math.round(syncDebugState.serverOffsetMs)}</p>
          <p>readyState: {syncDebugState.readyState ?? "n/a"}</p>
          <p>buffering: {String(syncDebugState.buffering ?? false)}</p>
          <p>readinessStage: {syncDebugState.readinessStage ?? "n/a"}</p>
          <p>recoveryState: {syncDebugState.recoveryState ?? "n/a"}</p>
          <p>playbackStartState: {syncDebugState.playbackStartState ?? "n/a"}</p>
          <p>autoplayBlocked: {String(syncDebugState.autoplayBlocked ?? false)}</p>
          <p>playIntentActive: {String(syncDebugState.playIntentActive ?? false)}</p>
          <p>
            recoveryAttemptsWindow: {syncDebugState.recoveryAttemptsWindow ?? "n/a"}
          </p>
          <p>lastErrorClass: {syncDebugState.lastErrorClass ?? "n/a"}</p>
          <p>
            lastResyncAt:{" "}
            {syncDebugState.lastResyncAt
              ? new Date(syncDebugState.lastResyncAt).toLocaleTimeString()
              : "n/a"}
          </p>
        </aside>
      ) : null}
    </div>
  );
}
