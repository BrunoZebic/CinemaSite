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

    const showPlayer =
      hasAccess && providerReady && videoAssetId && phase !== "DISCUSSION" && phase !== "CLOSED";

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
        ) : showPlayer ? (
          <div className="video-frame video-player-frame">
            <div className="video-player-host" ref={hostRef} />
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
            <p className="video-state">
              {phase === "DISCUSSION"
                ? "Discussion phase is open."
                : "Screening has closed."}
            </p>
          </div>
        )}
        <p className="video-status-note">{statusText}</p>
      </div>
    );
  },
);

export default VideoSyncPlayer;
