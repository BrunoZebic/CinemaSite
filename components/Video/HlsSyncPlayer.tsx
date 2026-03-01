"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  VideoSyncDebugState,
  VideoSyncPlayerHandle,
} from "@/components/Video/types";
import { clampPlaybackTargetSec } from "@/lib/premiere/phase";
import type {
  PremierePhase,
  RoomBootstrap,
  ScreeningConfig,
} from "@/lib/premiere/types";
import { HlsPlaybackAdapter, type HlsFatalError } from "@/lib/video/hlsAdapter";

const LOOP_INTERVAL_MS = 1500;
const READY_TIMEOUT_MS = 8000;
const HARD_SEEK_THRESHOLD_SEC = 2;
const INITIAL_ALIGNMENT_THRESHOLD_SEC = 0.5;
const SOFT_CORRECTION_THRESHOLD_SEC = 0.5;
const SOFT_CORRECTION_MAX_MS = 5000;

type HlsSyncPlayerProps = {
  room: string;
  screening: ScreeningConfig | null;
  phase: PremierePhase;
  hasAccess: boolean;
  serverOffsetMs: number;
  channelStatus: string;
  finalManifestUrl: string | null;
  requiresPriming: boolean;
  playbackConfigError: string | null;
  rehearsalScrubEnabled: boolean;
  onBootstrapRefresh?: () => Promise<RoomBootstrap | null>;
  onDebugStateChange?: (state: VideoSyncDebugState) => void;
};

type SyncOptions = {
  forceHardSeek?: boolean;
};

function getPrimingKey(room: string): string {
  return `playPrimed:${room}`;
}

const HlsSyncPlayer = forwardRef<VideoSyncPlayerHandle, HlsSyncPlayerProps>(
  function HlsSyncPlayer(
    {
      room,
      screening,
      phase,
      hasAccess,
      serverOffsetMs,
      channelStatus,
      finalManifestUrl,
      requiresPriming,
      playbackConfigError,
      rehearsalScrubEnabled,
      onBootstrapRefresh,
      onDebugStateChange,
    },
    ref,
  ) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const adapterRef = useRef<HlsPlaybackAdapter | null>(null);
    const driftLoopRef = useRef<number | null>(null);
    const isDriftLoopActiveRef = useRef(false);
    const softCorrectionStartedAtRef = useRef<number | null>(null);
    const supportsRateCorrectionRef = useRef(true);
    const lastResyncAtRef = useRef<number | null>(null);
    const recoveryInFlightRef = useRef(false);
    const liveAlignmentDoneRef = useRef(false);
    const phaseRef = useRef(phase);
    const hasAccessRef = useRef(hasAccess);
    const serverOffsetRef = useRef(serverOffsetMs);
    const screeningRef = useRef(screening);
    const finalManifestUrlRef = useRef(finalManifestUrl);
    const playPrimedRef = useRef(false);
    const bufferingRef = useRef(false);
    const onBootstrapRefreshRef = useRef(onBootstrapRefresh);
    const onDebugStateChangeRef = useRef(onDebugStateChange);
    const channelStatusRef = useRef(channelStatus);

    const [isPlayerReady, setIsPlayerReady] = useState(false);
    const [isPrimed, setIsPrimed] = useState(false);
    const [statusText, setStatusText] = useState("Loading stream...");
    const [isMuted, setIsMuted] = useState(false);
    const [volume, setVolume] = useState(1);
    const [isPlaying, setIsPlaying] = useState(false);
    const [readyState, setReadyState] = useState(0);
    const [buffering, setBuffering] = useState(false);
    const [playerTime, setPlayerTime] = useState(0);
    const [playerDuration, setPlayerDuration] = useState(0);
    const [driftDebug, setDriftDebug] = useState({
      playerTime: 0,
      targetTime: 0,
      drift: 0,
    });
    const driftDebugRef = useRef(driftDebug);
    const readyStateRef = useRef(readyState);

    phaseRef.current = phase;
    hasAccessRef.current = hasAccess;
    serverOffsetRef.current = serverOffsetMs;
    screeningRef.current = screening;
    finalManifestUrlRef.current = finalManifestUrl;
    onBootstrapRefreshRef.current = onBootstrapRefresh;
    onDebugStateChangeRef.current = onDebugStateChange;
    channelStatusRef.current = channelStatus;
    driftDebugRef.current = driftDebug;
    readyStateRef.current = readyState;

    const publishDebugState = useCallback(
      (patch?: Partial<VideoSyncDebugState>) => {
        const onDebugStateChangeCurrent = onDebugStateChangeRef.current;
        if (!onDebugStateChangeCurrent) {
          return;
        }

        const currentDriftDebug = driftDebugRef.current;
        onDebugStateChangeCurrent({
          phase: phaseRef.current,
          playerTime: currentDriftDebug.playerTime,
          targetTime: currentDriftDebug.targetTime,
          drift: currentDriftDebug.drift,
          isDriftLoopActive: isDriftLoopActiveRef.current,
          serverOffsetMs: serverOffsetRef.current,
          lastResyncAt: lastResyncAtRef.current,
          channelStatus: channelStatusRef.current,
          readyState: readyStateRef.current,
          buffering: bufferingRef.current,
          ...patch,
        });
      },
      [],
    );

    const setStatusIfChanged = useCallback((nextStatus: string) => {
      setStatusText((current) => (current === nextStatus ? current : nextStatus));
    }, []);

    const stopDriftLoop = useCallback(() => {
      if (driftLoopRef.current) {
        window.clearInterval(driftLoopRef.current);
        driftLoopRef.current = null;
      }
      isDriftLoopActiveRef.current = false;
      publishDebugState({
        isDriftLoopActive: false,
      });
    }, [publishDebugState]);

    const setPrimed = useCallback(
      (value: boolean) => {
        playPrimedRef.current = value;
        setIsPrimed(value);
        const key = getPrimingKey(room);
        if (value) {
          window.sessionStorage.setItem(key, "1");
        } else {
          window.sessionStorage.removeItem(key);
        }
      },
      [room],
    );

    const syncToCanonicalTime = useCallback(
      async (options?: SyncOptions) => {
        const adapter = adapterRef.current;
        const activeScreening = screeningRef.current;
        if (!adapter || !activeScreening) {
          return;
        }

        try {
          await adapter.waitUntilReady(READY_TIMEOUT_MS);
        } catch {
          setStatusText("Player is not ready yet.");
          return;
        }

        const now = Date.now();
        const rawTargetSec =
          (now + serverOffsetRef.current - activeScreening.premiereStartUnixMs) /
          1000;
        const targetTime = clampPlaybackTargetSec(
          rawTargetSec,
          activeScreening.filmDurationSec,
        );
        const currentPhase = phaseRef.current;

        if (currentPhase === "WAITING") {
          softCorrectionStartedAtRef.current = null;
          liveAlignmentDoneRef.current = false;
          await adapter.pause();
          await adapter.seekTo(0);
          bufferingRef.current = false;
          setBuffering(false);
          setStatusIfChanged("Waiting for stream to begin.");
          setDriftDebug((current) => ({
            ...current,
            targetTime,
            drift: 0,
          }));
          publishDebugState({
            targetTime,
            drift: 0,
          });
          return;
        }

        if (currentPhase === "SILENCE") {
          softCorrectionStartedAtRef.current = null;
          await adapter.pause();
          setStatusIfChanged("Silence interval in progress.");
          publishDebugState({
            targetTime,
          });
          return;
        }

        if (currentPhase === "DISCUSSION" || currentPhase === "CLOSED") {
          softCorrectionStartedAtRef.current = null;
          await adapter.pause();
          setStatusIfChanged(
            currentPhase === "DISCUSSION"
              ? "Discussion room is open."
              : "Screening has ended.",
          );
          publishDebugState({
            targetTime,
          });
          return;
        }

        if (requiresPriming && !playPrimedRef.current) {
          await adapter.pause();
          setStatusIfChanged("Tap to enable playback.");
          publishDebugState({
            targetTime,
          });
          return;
        }

        if (
          adapter.getReadyState() < 2 ||
          adapter.isBuffering() ||
          (!adapter.isNativeHls() && !adapter.isManifestParsed())
        ) {
          if (currentPhase === "LIVE") {
            setStatusIfChanged("Buffering stream...");
          } else if (currentPhase === "WAITING") {
            setStatusIfChanged("Waiting for stream to begin.");
          }
          publishDebugState({
            targetTime,
            readyState: adapter.getReadyState(),
            buffering: adapter.isBuffering(),
          });
          return;
        }

        const currentTime = await adapter.getCurrentTime();
        const drift = currentTime - targetTime;
        const absDrift = Math.abs(drift);
        const shouldHardSeekFirstLive =
          !liveAlignmentDoneRef.current &&
          (absDrift > INITIAL_ALIGNMENT_THRESHOLD_SEC || options?.forceHardSeek);

        if (shouldHardSeekFirstLive) {
          await adapter.seekTo(targetTime);
          liveAlignmentDoneRef.current = true;
          softCorrectionStartedAtRef.current = null;
          if (supportsRateCorrectionRef.current) {
            await adapter.setPlaybackRate(1);
          }
        } else if (!liveAlignmentDoneRef.current) {
          liveAlignmentDoneRef.current = true;
        } else if (absDrift > HARD_SEEK_THRESHOLD_SEC || options?.forceHardSeek) {
          softCorrectionStartedAtRef.current = null;
          await adapter.seekTo(targetTime);
          if (supportsRateCorrectionRef.current) {
            await adapter.setPlaybackRate(1);
          }
        } else if (supportsRateCorrectionRef.current && absDrift > SOFT_CORRECTION_THRESHOLD_SEC) {
          const nowMs = Date.now();
          if (softCorrectionStartedAtRef.current === null) {
            softCorrectionStartedAtRef.current = nowMs;
          }

          const elapsed = nowMs - softCorrectionStartedAtRef.current;
          if (elapsed <= SOFT_CORRECTION_MAX_MS) {
            try {
              await adapter.setPlaybackRate(drift > 0 ? 0.97 : 1.03);
            } catch {
              supportsRateCorrectionRef.current = false;
              softCorrectionStartedAtRef.current = null;
            }
          } else {
            softCorrectionStartedAtRef.current = null;
            await adapter.setPlaybackRate(1);
          }
        } else if (!supportsRateCorrectionRef.current && absDrift >= SOFT_CORRECTION_THRESHOLD_SEC) {
          softCorrectionStartedAtRef.current = null;
          await adapter.seekTo(targetTime);
        } else if (supportsRateCorrectionRef.current) {
          softCorrectionStartedAtRef.current = null;
          await adapter.setPlaybackRate(1);
        }

        await adapter.play();
        setStatusIfChanged("Live playback synchronized.");
        setDriftDebug({
          playerTime: currentTime,
          targetTime,
          drift,
        });
        publishDebugState({
          playerTime: currentTime,
          targetTime,
          drift,
          readyState: adapter.getReadyState(),
          buffering: adapter.isBuffering(),
        });
      },
      [publishDebugState, requiresPriming, setStatusIfChanged],
    );

    const recoverFromPlaybackFailure = useCallback(
      async (error: HlsFatalError) => {
        if (phaseRef.current !== "LIVE") {
          if (phaseRef.current === "WAITING") {
            setStatusIfChanged("Waiting for stream to begin.");
          } else if (phaseRef.current === "SILENCE") {
            setStatusIfChanged("Silence interval in progress.");
          } else if (phaseRef.current === "DISCUSSION") {
            setStatusIfChanged("Discussion room is open.");
          } else {
            setStatusIfChanged("Screening has ended.");
          }
          return;
        }

        if (recoveryInFlightRef.current) {
          return;
        }
        recoveryInFlightRef.current = true;
        stopDriftLoop();

        try {
          const adapter = adapterRef.current;
          const videoElement = videoRef.current;
          if (!adapter || !videoElement) {
            return;
          }

          setStatusIfChanged(
            error.isForbidden
              ? "Stream token expired. Refreshing stream..."
              : "Stream interrupted. Attempting recovery...",
          );
          await adapter.pause();

          const freshBootstrap = (await onBootstrapRefreshRef.current?.()) ?? null;
          const nextManifestUrl =
            freshBootstrap?.finalManifestUrl ?? finalManifestUrlRef.current;
          if (!nextManifestUrl) {
            throw new Error("No signed manifest URL available for recovery.");
          }

          await adapter.initialize(videoElement, nextManifestUrl);
          await adapter.waitUntilReady(READY_TIMEOUT_MS);
          liveAlignmentDoneRef.current = false;
          lastResyncAtRef.current = Date.now();
          await syncToCanonicalTime({
            forceHardSeek: true,
          });
          setStatusIfChanged("Stream recovered.");
          publishDebugState({
            lastResyncAt: lastResyncAtRef.current,
          });
        } catch (recoveryError) {
          console.error(recoveryError);
          setStatusIfChanged("Playback recovery failed.");
        } finally {
          recoveryInFlightRef.current = false;
        }
      },
      [publishDebugState, setStatusIfChanged, stopDriftLoop, syncToCanonicalTime],
    );

    useImperativeHandle(
      ref,
      () => ({
        resyncToCanonicalTime: async () => {
          lastResyncAtRef.current = Date.now();
          await syncToCanonicalTime({
            forceHardSeek: true,
          });
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
      const primed = window.sessionStorage.getItem(getPrimingKey(room)) === "1";
      playPrimedRef.current = primed;
      setIsPrimed(primed);
    }, [room]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      const onTimeUpdate = () => {
        setPlayerTime(video.currentTime || 0);
        setPlayerDuration(video.duration || 0);
      };
      const onPlay = () => {
        setIsPlaying(true);
      };
      const onPause = () => {
        setIsPlaying(false);
      };
      const onVolumeChange = () => {
        setIsMuted(video.muted);
        setVolume(video.volume);
      };
      const onReadyStateEvent = () => {
        setReadyState(video.readyState);
      };
      const onWaiting = () => {
        if (phaseRef.current !== "LIVE") {
          return;
        }
        bufferingRef.current = true;
        setBuffering(true);
        setStatusIfChanged("Buffering stream...");
        stopDriftLoop();
      };
      const onRecovered = () => {
        if (!bufferingRef.current) {
          return;
        }
        bufferingRef.current = false;
        setBuffering(false);
        if (phaseRef.current === "LIVE") {
          void (async () => {
            await syncToCanonicalTime({
              forceHardSeek: true,
            });
          })();
          return;
        }
        if (phaseRef.current === "WAITING") {
          setStatusIfChanged("Waiting for stream to begin.");
        }
      };
      const onError = () => {
        void recoverFromPlaybackFailure({
          isForbidden: false,
        });
      };

      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("play", onPlay);
      video.addEventListener("pause", onPause);
      video.addEventListener("volumechange", onVolumeChange);
      video.addEventListener("loadedmetadata", onReadyStateEvent);
      video.addEventListener("canplay", onReadyStateEvent);
      video.addEventListener("playing", onReadyStateEvent);
      video.addEventListener("waiting", onWaiting);
      video.addEventListener("stalled", onWaiting);
      video.addEventListener("canplay", onRecovered);
      video.addEventListener("playing", onRecovered);
      video.addEventListener("error", onError);

      return () => {
        video.removeEventListener("timeupdate", onTimeUpdate);
        video.removeEventListener("play", onPlay);
        video.removeEventListener("pause", onPause);
        video.removeEventListener("volumechange", onVolumeChange);
        video.removeEventListener("loadedmetadata", onReadyStateEvent);
        video.removeEventListener("canplay", onReadyStateEvent);
        video.removeEventListener("playing", onReadyStateEvent);
        video.removeEventListener("waiting", onWaiting);
        video.removeEventListener("stalled", onWaiting);
        video.removeEventListener("canplay", onRecovered);
        video.removeEventListener("playing", onRecovered);
        video.removeEventListener("error", onError);
      };
    }, [
      recoverFromPlaybackFailure,
      setStatusIfChanged,
      stopDriftLoop,
      syncToCanonicalTime,
    ]);

    useEffect(() => {
      if (!hasAccess || !screening || screening.videoProvider !== "hls") {
        stopDriftLoop();
        return;
      }
      if (!finalManifestUrl) {
        setStatusText(playbackConfigError ?? "Signed HLS stream is unavailable.");
        stopDriftLoop();
        return;
      }

      const videoElement = videoRef.current;
      if (!videoElement) {
        return;
      }

      let cancelled = false;
      const adapter = adapterRef.current ?? new HlsPlaybackAdapter();
      adapterRef.current = adapter;
      adapter.setFatalListener((error) => {
        void recoverFromPlaybackFailure(error);
      });

      const initialize = async () => {
        try {
          setIsPlayerReady(false);
          setStatusIfChanged("Loading stream...");
          await adapter.initialize(videoElement, finalManifestUrl);
          await adapter.waitUntilReady(READY_TIMEOUT_MS);
          if (cancelled) {
            return;
          }
          setIsPlayerReady(true);
          setReadyState(adapter.getReadyState());
          setStatusIfChanged("HLS stream ready.");
          await syncToCanonicalTime({
            forceHardSeek: true,
          });
        } catch (error) {
          console.error(error);
          if (!cancelled) {
            setStatusIfChanged("Unable to initialize HLS stream.");
          }
        }
      };

      void initialize();

      return () => {
        cancelled = true;
        stopDriftLoop();
        setIsPlayerReady(false);
        void adapter.destroy();
      };
    }, [
      finalManifestUrl,
      hasAccess,
      playbackConfigError,
      recoverFromPlaybackFailure,
      screening,
      setStatusIfChanged,
      stopDriftLoop,
      syncToCanonicalTime,
    ]);

    useEffect(() => {
      if (phase !== "LIVE") {
        liveAlignmentDoneRef.current = false;
      }
      if (!isPlayerReady) {
        return;
      }

      const timer = window.setTimeout(() => {
        void syncToCanonicalTime();
      }, 0);
      return () => window.clearTimeout(timer);
    }, [isPlayerReady, phase, syncToCanonicalTime]);

    useEffect(() => {
      const adapter = adapterRef.current;
      const canRunLoop =
        Boolean(adapter) &&
        isPlayerReady &&
        hasAccess &&
        phase === "LIVE" &&
        (!requiresPriming || isPrimed) &&
        !buffering &&
        (adapter?.getReadyState() ?? 0) >= 2 &&
        (adapter?.isNativeHls() || adapter?.isManifestParsed());

      if (!canRunLoop) {
        stopDriftLoop();
        return;
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
      };
    }, [
      buffering,
      hasAccess,
      isPlayerReady,
      isPrimed,
      phase,
      publishDebugState,
      requiresPriming,
      stopDriftLoop,
      syncToCanonicalTime,
    ]);

    const primePlayback = useCallback(async () => {
      const adapter = adapterRef.current;
      if (!adapter) {
        setStatusText("Player is not ready for priming.");
        return;
      }

      try {
        await adapter.waitUntilReady(READY_TIMEOUT_MS);
        await adapter.play();
        window.setTimeout(() => {
          void adapter.pause();
        }, 150);
        setPrimed(true);
        setStatusIfChanged("Playback primed. Ready for LIVE start.");
      } catch (error) {
        console.error(error);
        setStatusIfChanged("Priming failed. Tap again.");
      }
    }, [setPrimed, setStatusIfChanged]);

    const handlePlayPause = useCallback(async () => {
      const adapter = adapterRef.current;
      if (!adapter) {
        return;
      }

      if (requiresPriming && !isPrimed) {
        await primePlayback();
        return;
      }

      try {
        if (isPlaying) {
          await adapter.pause();
        } else {
          await adapter.play();
        }
      } catch (error) {
        console.error(error);
      }
    }, [isPlaying, isPrimed, primePlayback, requiresPriming]);

    const handleToggleMute = useCallback(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      video.muted = !video.muted;
      setIsMuted(video.muted);
    }, []);

    const handleVolumeChange = useCallback((nextVolume: number) => {
      const video = videoRef.current;
      if (!video) {
        return;
      }
      video.volume = nextVolume;
      if (nextVolume > 0 && video.muted) {
        video.muted = false;
      }
      setVolume(nextVolume);
      setIsMuted(video.muted);
    }, []);

    const handleFullscreen = useCallback(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      if (video.requestFullscreen) {
        void video.requestFullscreen();
        return;
      }

      const webkitVideo = video as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
        webkitRequestFullscreen?: () => void;
      };

      if (webkitVideo.webkitRequestFullscreen) {
        webkitVideo.webkitRequestFullscreen();
      } else if (webkitVideo.webkitEnterFullscreen) {
        webkitVideo.webkitEnterFullscreen();
      }
    }, []);

    const handleScrub = useCallback(
      async (nextTime: number) => {
        const adapter = adapterRef.current;
        if (!adapter) {
          return;
        }

        await adapter.seekTo(nextTime);
        await syncToCanonicalTime({
          forceHardSeek: true,
        });
      },
      [syncToCanonicalTime],
    );

    const showPlayer =
      hasAccess &&
      screening?.videoProvider === "hls" &&
      phase !== "DISCUSSION" &&
      phase !== "CLOSED" &&
      !playbackConfigError;

    const shouldShowPrimePrompt =
      showPlayer && requiresPriming && !isPrimed && (phase === "WAITING" || phase === "LIVE");
    const scrubEnabled =
      rehearsalScrubEnabled && phase !== "LIVE" && phase !== "SILENCE" && showPlayer;

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
        ) : playbackConfigError ? (
          <div className="video-frame">
            <p className="video-state">{playbackConfigError}</p>
          </div>
        ) : showPlayer ? (
          <div className="video-frame video-player-frame hls-player-frame">
            <video
              ref={videoRef}
              className="hls-video-element"
              playsInline
              preload="auto"
            />
            {phase === "SILENCE" ? (
              <div className="video-blackout">
                <p>Silence</p>
              </div>
            ) : null}
            {shouldShowPrimePrompt ? (
              <div className="video-prime-overlay">
                <p>Tap to enable playback</p>
                <button type="button" onClick={() => void primePlayback()}>
                  Enable Playback
                </button>
              </div>
            ) : null}
            <div className="video-controls">
              <button
                type="button"
                onClick={() => void handlePlayPause()}
                disabled={!isPlayerReady || phase === "SILENCE" || phase === "WAITING"}
              >
                {isPlaying ? "Pause" : "Play"}
              </button>
              <button type="button" onClick={handleToggleMute}>
                {isMuted ? "Unmute" : "Mute"}
              </button>
              <label className="volume-control">
                <span>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={(event) =>
                    handleVolumeChange(Number(event.currentTarget.value))
                  }
                />
              </label>
              <button type="button" onClick={handleFullscreen}>
                Fullscreen
              </button>
            </div>
            {scrubEnabled ? (
              <label className="scrub-control">
                <span>Rehearsal Scrub</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, Math.floor(playerDuration || 1))}
                  step={1}
                  value={Math.floor(playerTime)}
                  onChange={(event) =>
                    void handleScrub(Number(event.currentTarget.value))
                  }
                />
              </label>
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
        <p className="video-status-note">
          {statusText}{" "}
          {buffering ? "(buffering)" : ""}{" "}
          {phase === "LIVE" && !isDriftLoopActiveRef.current ? "(sync idle)" : ""}
        </p>
      </div>
    );
  },
);

export default HlsSyncPlayer;
