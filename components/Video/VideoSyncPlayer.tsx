"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { clampPlaybackTargetSec } from "@/lib/premiere/phase";
import {
  isPlaybackSurfacePhase,
  screenVisualStateForPhase,
} from "@/lib/premiere/presentation";
import type { PremierePhase, ScreeningConfig } from "@/lib/premiere/types";
import type {
  VideoSyncDebugState,
  VideoSyncPlayerHandle,
} from "@/components/Video/types";
import { VimeoPlaybackAdapter } from "@/lib/playback/vimeoAdapter";
import type { PlaybackAdapter } from "@/lib/playback/types";

const LOOP_INTERVAL_MS = 1500;
const SOFT_CORRECTION_WINDOW_MS = 5000;
const HARD_SEEK_THRESHOLD_SEC = 2;
const DEFAULT_SOFT_THRESHOLD_SEC = 0.25;
const NO_RATE_SOFT_THRESHOLD_SEC = 0.5;

type VideoSyncPlayerProps = {
  room: string;
  screening: ScreeningConfig | null;
  phase: PremierePhase;
  hasAccess: boolean;
  serverOffsetMs: number;
  channelStatus: string;
  onDebugStateChange?: (state: VideoSyncDebugState) => void;
};

function isLivePhase(phase: PremierePhase): boolean {
  return phase === "LIVE";
}

function phaseMessage(phase: PremierePhase): string {
  if (phase === "DISCUSSION") {
    return "Discussion is open.";
  }
  if (phase === "CLOSED") {
    return "Screening concluded.";
  }
  if (phase === "WAITING") {
    return "Premiere is waiting to begin.";
  }
  return "Screen is preparing.";
}

const VideoSyncPlayer = forwardRef<VideoSyncPlayerHandle, VideoSyncPlayerProps>(
  function VideoSyncPlayer(
    {
      room,
      screening,
      phase,
      hasAccess,
      serverOffsetMs,
      channelStatus,
      onDebugStateChange,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const adapterRef = useRef<PlaybackAdapter | null>(null);
    const supportsRateCorrectionRef = useRef(true);
    const driftLoopRef = useRef<number | null>(null);
    const isDriftLoopActiveRef = useRef(false);
    const softCorrectionStartedAtRef = useRef<number | null>(null);
    const lastResyncAtRef = useRef<number | null>(null);
    const [isPlayerReady, setIsPlayerReady] = useState(false);
    const [statusText, setStatusText] = useState("Loading player...");
    const [driftDebug, setDriftDebug] = useState({
      playerTime: 0,
      targetTime: 0,
      drift: 0,
    });

    const providerReady = screening?.videoProvider === "vimeo";
    const videoAssetId = screening?.videoAssetId ?? "";
    const posterImageUrl = screening?.posterImageUrl ?? null;

    const publishDebugState = useCallback(
      (patch?: Partial<VideoSyncDebugState>) => {
        if (!onDebugStateChange) {
          return;
        }

        onDebugStateChange({
          phase,
          playerTime: driftDebug.playerTime,
          targetTime: driftDebug.targetTime,
          drift: driftDebug.drift,
          isDriftLoopActive: isDriftLoopActiveRef.current,
          serverOffsetMs,
          lastResyncAt: lastResyncAtRef.current,
          channelStatus,
          ...patch,
        });
      },
      [
        channelStatus,
        driftDebug.drift,
        driftDebug.playerTime,
        driftDebug.targetTime,
        onDebugStateChange,
        phase,
        serverOffsetMs,
      ],
    );

    const stopDriftLoop = useCallback(() => {
      if (driftLoopRef.current) {
        window.clearInterval(driftLoopRef.current);
        driftLoopRef.current = null;
      }
      isDriftLoopActiveRef.current = false;
    }, []);

    const syncToCanonicalTime = useCallback(async () => {
      const adapter = adapterRef.current;
      if (!adapter || !screening) {
        return;
      }

      try {
        await adapter.waitUntilReady(5000);
      } catch {
        setStatusText("Player is not ready yet.");
        return;
      }

      const now = Date.now();
      const rawTargetSec =
        (now + serverOffsetMs - screening.premiereStartUnixMs) / 1000;
      const target = clampPlaybackTargetSec(rawTargetSec, screening.filmDurationSec);

      if (phase === "WAITING") {
        softCorrectionStartedAtRef.current = null;
        await adapter.pause();
        await adapter.seekTo(0);
        setStatusText("Premiere is waiting to begin.");
        setDriftDebug((current) => ({
          ...current,
          targetTime: target,
          drift: 0,
        }));
        publishDebugState({
          targetTime: target,
          drift: 0,
        });
        return;
      }

      if (phase === "SILENCE") {
        softCorrectionStartedAtRef.current = null;
        await adapter.pause();
        setStatusText("Silence interval in progress.");
        publishDebugState({
          targetTime: target,
        });
        return;
      }

      if (phase === "DISCUSSION" || phase === "CLOSED") {
        softCorrectionStartedAtRef.current = null;
        await adapter.pause();
        setStatusText(
          phase === "DISCUSSION"
            ? "Discussion room is open."
            : "Screening has ended.",
        );
        publishDebugState({
          targetTime: target,
        });
        return;
      }

      const playerTime = await adapter.getCurrentTime();
      const drift = playerTime - target;
      const absDrift = Math.abs(drift);

      if (absDrift > HARD_SEEK_THRESHOLD_SEC) {
        softCorrectionStartedAtRef.current = null;
        await adapter.seekTo(target);
        if (supportsRateCorrectionRef.current) {
          await adapter.setPlaybackRate(1);
        }
      } else if (supportsRateCorrectionRef.current) {
        const nowMs = Date.now();
        const softThreshold = DEFAULT_SOFT_THRESHOLD_SEC;
        if (absDrift > softThreshold) {
          if (softCorrectionStartedAtRef.current === null) {
            softCorrectionStartedAtRef.current = nowMs;
          }

          const elapsedMs = nowMs - softCorrectionStartedAtRef.current;
          if (elapsedMs <= SOFT_CORRECTION_WINDOW_MS) {
            const nextRate = drift > 0 ? 0.97 : 1.03;
            try {
              await adapter.setPlaybackRate(nextRate);
            } catch {
              supportsRateCorrectionRef.current = false;
            }
          } else {
            softCorrectionStartedAtRef.current = null;
            await adapter.setPlaybackRate(1);
          }
        } else {
          softCorrectionStartedAtRef.current = null;
          await adapter.setPlaybackRate(1);
        }
      } else if (absDrift >= NO_RATE_SOFT_THRESHOLD_SEC) {
        softCorrectionStartedAtRef.current = null;
        await adapter.seekTo(target);
      }

      await adapter.play();
      setStatusText("Live playback synchronized.");
      setDriftDebug({
        playerTime,
        targetTime: target,
        drift,
      });
      publishDebugState({
        playerTime,
        targetTime: target,
        drift,
      });
    }, [phase, publishDebugState, screening, serverOffsetMs]);

    useImperativeHandle(
      ref,
      () => ({
        resyncToCanonicalTime: async () => {
          lastResyncAtRef.current = Date.now();
          await syncToCanonicalTime();
          publishDebugState({
            lastResyncAt: lastResyncAtRef.current,
          });
        },
      }),
      [publishDebugState, syncToCanonicalTime],
    );

    useEffect(() => {
      publishDebugState();
    }, [publishDebugState]);

    useEffect(() => {
      if (!hasAccess || !providerReady || !videoAssetId || !hostRef.current) {
        return;
      }

      let cancelled = false;
      const adapter = new VimeoPlaybackAdapter(hostRef.current, videoAssetId);
      adapterRef.current = adapter;

      const initialize = async () => {
        try {
          await adapter.initialize();
          if (cancelled) {
            return;
          }
          setIsPlayerReady(true);
          setStatusText("Video player ready.");
          await adapter.pause();
        } catch (error) {
          console.error(error);
          if (!cancelled) {
            setStatusText("Unable to initialize Vimeo player.");
          }
        }
      };

      void initialize();

      return () => {
        cancelled = true;
        stopDriftLoop();
        void adapter.destroy();
        if (adapterRef.current === adapter) {
          adapterRef.current = null;
        }
      };
    }, [hasAccess, providerReady, room, stopDriftLoop, videoAssetId]);

    useEffect(() => {
      if (!isPlayerReady || !adapterRef.current) {
        return;
      }

      const timer = window.setTimeout(() => {
        void syncToCanonicalTime();
      }, 0);
      return () => window.clearTimeout(timer);
    }, [isPlayerReady, phase, syncToCanonicalTime]);

    useEffect(() => {
      if (!isPlayerReady || !isLivePhase(phase) || !hasAccess) {
        const timer = window.setTimeout(() => {
          stopDriftLoop();
        }, 0);
        return () => window.clearTimeout(timer);
      }

      if (driftLoopRef.current) {
        window.clearInterval(driftLoopRef.current);
        driftLoopRef.current = null;
      }

      driftLoopRef.current = window.setInterval(() => {
        void syncToCanonicalTime();
      }, LOOP_INTERVAL_MS);
      isDriftLoopActiveRef.current = true;
      publishDebugState({
        isDriftLoopActive: true,
      });

      return () => {
        stopDriftLoop();
        publishDebugState({
          isDriftLoopActive: false,
        });
      };
    }, [
      hasAccess,
      isPlayerReady,
      phase,
      publishDebugState,
      stopDriftLoop,
      syncToCanonicalTime,
    ]);

    const hasPresentationShell = Boolean(screening && hasAccess);
    const showPlaybackSurface =
      hasPresentationShell &&
      providerReady &&
      Boolean(videoAssetId) &&
      isPlaybackSurfacePhase(phase);
    const showPosterLayer =
      hasPresentationShell &&
      (phase === "DISCUSSION" || phase === "CLOSED") &&
      Boolean(posterImageUrl);
    const showStaticPresentation =
      hasPresentationShell && !showPlaybackSurface && !showPosterLayer;
    const screenVisualState = screenVisualStateForPhase(
      phase,
      Boolean(posterImageUrl),
    );

    return (
      <div className="video-shell">
        <h2 className="video-heading">Screen</h2>
        {!screening ? (
          <div className="video-frame">
            <p className="video-state">This room has no active screening config.</p>
          </div>
        ) : !hasAccess ? (
          <div className="video-frame">
            <p className="video-state">Enter invite code to unlock the screen.</p>
          </div>
        ) : hasPresentationShell ? (
          <div
            className="video-frame video-player-frame video-presentation-shell"
            data-testid="player-presentation-shell"
            data-phase={phase}
            data-screen-visual-state={screenVisualState}
            data-player-fullscreen="false"
          >
            {showPlaybackSurface ? (
              <div className="video-playback-layer">
                <div className="video-player-host" ref={hostRef} />
              </div>
            ) : null}
            {showPosterLayer ? (
              <div className="video-poster-layer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={posterImageUrl ?? undefined}
                  alt={`${screening.title} poster`}
                  className="video-poster-image"
                  data-testid="phase-poster-image"
                />
                <div className="video-poster-meta">
                  <p className="video-poster-kicker">
                    {phase === "DISCUSSION" ? "Discussion" : "Closed"}
                  </p>
                  <p className="video-poster-title">{screening.title}</p>
                </div>
              </div>
            ) : null}
            <div className="video-transition-overlay" aria-hidden="true" />
            {showStaticPresentation ? (
              <div className="video-presentation-card" data-testid="phase-static-treatment">
                <p className="video-presentation-kicker">
                  {phase === "DISCUSSION"
                    ? "Discussion"
                    : phase === "CLOSED"
                      ? "Closed"
                      : "Screen"}
                </p>
                <p className="video-presentation-title">{screening.title}</p>
                <p className="video-state">{phaseMessage(phase)}</p>
              </div>
            ) : null}
            {phase === "WAITING" ? (
              <div data-testid="waiting-lobby-overlay" hidden />
            ) : null}
            {phase === "SILENCE" ? (
              <div className="video-blackout" data-testid="silence-blackout">
                <p>Silence</p>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="video-frame">
            <p className="video-state">Screen presentation is unavailable.</p>
          </div>
        )}
        <p className="video-status-note">{statusText}</p>
      </div>
    );
  },
);

export default VideoSyncPlayer;
