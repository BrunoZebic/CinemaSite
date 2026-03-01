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
  HlsRecoveryErrorClass,
  HlsRecoveryState,
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
const RECOVERY_READY_TIMEOUT_MS = 10000;
const HARD_SEEK_THRESHOLD_SEC = 2;
const INITIAL_ALIGNMENT_THRESHOLD_SEC = 0.5;
const SOFT_CORRECTION_THRESHOLD_SEC = 0.5;
const SOFT_CORRECTION_MAX_MS = 5000;
const NO_PROGRESS_WATCHDOG_MS = 12_000;
const PREEMPTIVE_REFRESH_THRESHOLD_MS = 180_000;
const TOKEN_REFRESH_COOLDOWN_MS = 60_000;
const AUTH_RECOVERY_WINDOW_MS = 30_000;
const AUTH_RECOVERY_MAX_ATTEMPTS = 2;

type HlsSyncPlayerProps = {
  room: string;
  screening: ScreeningConfig | null;
  phase: PremierePhase;
  hasAccess: boolean;
  serverOffsetMs: number;
  channelStatus: string;
  finalManifestUrl: string | null;
  tokenExpiresAtUnixMs: number | null;
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

function classifyFatalError(error: HlsFatalError): HlsRecoveryErrorClass {
  if (error.isForbidden || error.statusCode === 401 || error.statusCode === 403) {
    return "AUTH_SUSPECTED";
  }
  return "NETWORK_OR_PARSE";
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
      tokenExpiresAtUnixMs,
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
    const tokenExpiresAtRef = useRef(tokenExpiresAtUnixMs);
    const playPrimedRef = useRef(false);
    const bufferingRef = useRef(false);
    const onBootstrapRefreshRef = useRef(onBootstrapRefresh);
    const onDebugStateChangeRef = useRef(onDebugStateChange);
    const channelStatusRef = useRef(channelStatus);
    const recoveryStateRef = useRef<HlsRecoveryState>("IDLE");
    const lastErrorClassRef = useRef<HlsRecoveryErrorClass | null>(null);
    const authRecoveryAttemptsRef = useRef<number[]>([]);
    const networkRecoveryStepRef = useRef<0 | 1 | 2>(0);
    const lastProgressAtRef = useRef<number>(Date.now());
    const lastKnownCurrentTimeRef = useRef<number>(0);
    const lastTokenRefreshAtRef = useRef<number>(0);
    const skipEffectInitUrlRef = useRef<string | null>(null);

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
    const [recoveryState, setRecoveryState] = useState<HlsRecoveryState>("IDLE");
    const [lastErrorClass, setLastErrorClass] =
      useState<HlsRecoveryErrorClass | null>(null);
    const driftDebugRef = useRef(driftDebug);
    const readyStateRef = useRef(readyState);

    phaseRef.current = phase;
    hasAccessRef.current = hasAccess;
    serverOffsetRef.current = serverOffsetMs;
    screeningRef.current = screening;
    finalManifestUrlRef.current = finalManifestUrl;
    tokenExpiresAtRef.current = tokenExpiresAtUnixMs;
    onBootstrapRefreshRef.current = onBootstrapRefresh;
    onDebugStateChangeRef.current = onDebugStateChange;
    channelStatusRef.current = channelStatus;
    driftDebugRef.current = driftDebug;
    readyStateRef.current = readyState;
    recoveryStateRef.current = recoveryState;
    lastErrorClassRef.current = lastErrorClass;

    const publishDebugState = useCallback(
      (patch?: Partial<VideoSyncDebugState>) => {
        const onDebugStateChangeCurrent = onDebugStateChangeRef.current;
        if (!onDebugStateChangeCurrent) {
          return;
        }

        const currentDriftDebug = driftDebugRef.current;
        const adapter = adapterRef.current;
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
          readinessStage: adapter?.getReadinessStage() ?? "INIT",
          recoveryState: recoveryStateRef.current,
          recoveryAttemptsWindow: `auth:${authRecoveryAttemptsRef.current.length}/${AUTH_RECOVERY_MAX_ATTEMPTS} net:${networkRecoveryStepRef.current}/2`,
          lastErrorClass: lastErrorClassRef.current,
          ...patch,
        });
      },
      [],
    );

    const setStatusIfChanged = useCallback((nextStatus: string) => {
      setStatusText((current) => (current === nextStatus ? current : nextStatus));
    }, []);

    const updateRecoveryState = useCallback((next: HlsRecoveryState) => {
      recoveryStateRef.current = next;
      setRecoveryState(next);
    }, []);

    const updateLastErrorClass = useCallback(
      (next: HlsRecoveryErrorClass | null) => {
        lastErrorClassRef.current = next;
        setLastErrorClass(next);
      },
      [],
    );

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
          setStatusIfChanged("Player is not ready yet.");
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
        if (networkRecoveryStepRef.current > 0) {
          networkRecoveryStepRef.current = 0;
        }
        if (recoveryStateRef.current !== "DEGRADED") {
          updateRecoveryState("IDLE");
        }
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
      [
        publishDebugState,
        requiresPriming,
        setStatusIfChanged,
        updateRecoveryState,
      ],
    );

    const reinitializeWithUrl = useCallback(
      async (
        nextManifestUrl: string,
        options?: {
          announce?: string;
          readyTimeoutMs?: number;
        },
      ) => {
        const adapter = adapterRef.current;
        const videoElement = videoRef.current;
        if (!adapter || !videoElement) {
          throw new Error("Playback adapter is unavailable.");
        }

        if (options?.announce) {
          setStatusIfChanged(options.announce);
        }

        stopDriftLoop();
        setIsPlayerReady(false);
        finalManifestUrlRef.current = nextManifestUrl;
        skipEffectInitUrlRef.current = nextManifestUrl;
        await adapter.initialize(videoElement, nextManifestUrl);
        await adapter.waitUntilReady(options?.readyTimeoutMs ?? RECOVERY_READY_TIMEOUT_MS);
        setIsPlayerReady(true);
        setReadyState(adapter.getReadyState());
        liveAlignmentDoneRef.current = false;
        lastResyncAtRef.current = Date.now();
        await syncToCanonicalTime({
          forceHardSeek: true,
        });
        publishDebugState({
          lastResyncAt: lastResyncAtRef.current,
        });
      },
      [publishDebugState, setStatusIfChanged, stopDriftLoop, syncToCanonicalTime],
    );

    const enterDegradedState = useCallback(
      (errorClass: HlsRecoveryErrorClass, message: string) => {
        updateLastErrorClass(errorClass);
        updateRecoveryState("DEGRADED");
        setStatusIfChanged(message);
        stopDriftLoop();
      },
      [setStatusIfChanged, stopDriftLoop, updateLastErrorClass, updateRecoveryState],
    );

    const recoverNetworkOrParse = useCallback(async (): Promise<boolean> => {
      const currentUrl = finalManifestUrlRef.current;
      if (!currentUrl) {
        enterDegradedState(
          "NETWORK_OR_PARSE",
          "Playback issue - Retry to reconnect stream.",
        );
        return false;
      }

      if (networkRecoveryStepRef.current === 0) {
        networkRecoveryStepRef.current = 1;
        await reinitializeWithUrl(currentUrl, {
          announce: "Reconnecting stream...",
          readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
        });
        return true;
      }

      if (networkRecoveryStepRef.current === 1) {
        networkRecoveryStepRef.current = 2;
        const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
        const refreshedUrl = refreshed?.finalManifestUrl ?? currentUrl;
        if (refreshed?.tokenExpiresAtUnixMs) {
          tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
        }
        if (!refreshedUrl) {
          enterDegradedState(
            "NETWORK_OR_PARSE",
            "Playback issue - Retry to reconnect stream.",
          );
          return false;
        }
        await reinitializeWithUrl(refreshedUrl, {
          announce: "Refreshing stream token...",
          readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
        });
        return true;
      }

      enterDegradedState(
        "NETWORK_OR_PARSE",
        "Playback issue - Retry to reconnect stream.",
      );
      return false;
    }, [enterDegradedState, reinitializeWithUrl]);

    const attemptRecovery = useCallback(
      async (errorClass: HlsRecoveryErrorClass): Promise<void> => {
        if (recoveryInFlightRef.current || recoveryStateRef.current === "DEGRADED") {
          return;
        }

        recoveryInFlightRef.current = true;
        updateRecoveryState("RECOVERING");
        updateLastErrorClass(errorClass);

        try {
          if (errorClass === "AUTH_SUSPECTED") {
            const now = Date.now();
            authRecoveryAttemptsRef.current = authRecoveryAttemptsRef.current.filter(
              (ts) => now - ts <= AUTH_RECOVERY_WINDOW_MS,
            );
            if (authRecoveryAttemptsRef.current.length >= AUTH_RECOVERY_MAX_ATTEMPTS) {
              enterDegradedState(
                "AUTH_SUSPECTED",
                "Playback issue - Retry to refresh access.",
              );
              return;
            }

            const attemptIndex = authRecoveryAttemptsRef.current.length;
            authRecoveryAttemptsRef.current.push(now);
            const backoffMs = attemptIndex === 0 ? 1000 : 2000;
            await new Promise((resolve) => window.setTimeout(resolve, backoffMs));

            const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
            const nextUrl =
              refreshed?.finalManifestUrl ?? finalManifestUrlRef.current;
            if (refreshed?.tokenExpiresAtUnixMs) {
              tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
            }
            if (!nextUrl) {
              enterDegradedState(
                "AUTH_SUSPECTED",
                "Playback issue - Retry to refresh access.",
              );
              return;
            }

            await reinitializeWithUrl(nextUrl, {
              announce: "Refreshing stream access...",
              readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
            });
            networkRecoveryStepRef.current = 0;
            setStatusIfChanged("Stream recovered.");
            updateRecoveryState("IDLE");
            return;
          }

          if (errorClass === "MEDIA_STALL") {
            const adapter = adapterRef.current;
            if (adapter) {
              try {
                await adapter.pause();
                await adapter.play();
                await syncToCanonicalTime({
                  forceHardSeek: true,
                });
              } catch {
                // Escalate to network recovery path below.
              }
            }

            if (Date.now() - lastProgressAtRef.current < NO_PROGRESS_WATCHDOG_MS / 2) {
              setStatusIfChanged("Stream recovered.");
              updateRecoveryState("IDLE");
              return;
            }
          }

          const recovered = await recoverNetworkOrParse();
          if (recovered) {
            setStatusIfChanged("Stream recovered.");
            updateRecoveryState("IDLE");
          }
        } catch (error) {
          console.error(error);
          const nextClass =
            errorClass === "AUTH_SUSPECTED" ? "AUTH_SUSPECTED" : "NETWORK_OR_PARSE";
          updateLastErrorClass(nextClass);
          const recovered = await recoverNetworkOrParse();
          if (recovered) {
            updateRecoveryState("IDLE");
            setStatusIfChanged("Stream recovered.");
          }
        } finally {
          recoveryInFlightRef.current = false;
          publishDebugState();
        }
      },
      [
        enterDegradedState,
        publishDebugState,
        recoverNetworkOrParse,
        reinitializeWithUrl,
        setStatusIfChanged,
        syncToCanonicalTime,
        updateLastErrorClass,
        updateRecoveryState,
      ],
    );

    const recoverFromPlaybackFailure = useCallback(
      async (error: HlsFatalError) => {
        const currentPhase = phaseRef.current;
        if (currentPhase !== "LIVE") {
          if (currentPhase === "WAITING") {
            setStatusIfChanged("Waiting for stream to begin.");
          } else if (currentPhase === "SILENCE") {
            setStatusIfChanged("Silence interval in progress.");
          } else if (currentPhase === "DISCUSSION") {
            setStatusIfChanged("Discussion room is open.");
          } else {
            setStatusIfChanged("Screening has ended.");
          }
          return;
        }

        await attemptRecovery(classifyFatalError(error));
      },
      [attemptRecovery, setStatusIfChanged],
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
        const nextTime = video.currentTime || 0;
        if (nextTime > lastKnownCurrentTimeRef.current + 0.05) {
          lastProgressAtRef.current = Date.now();
          lastKnownCurrentTimeRef.current = nextTime;
        }
        setPlayerTime(nextTime);
        setPlayerDuration(video.duration || 0);
      };
      const onPlay = () => {
        setIsPlaying(true);
        lastProgressAtRef.current = Date.now();
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
      if (
        finalManifestUrl &&
        skipEffectInitUrlRef.current &&
        finalManifestUrl === skipEffectInitUrlRef.current
      ) {
        skipEffectInitUrlRef.current = null;
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
          updateRecoveryState("IDLE");
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
          networkRecoveryStepRef.current = 0;
          if (phaseRef.current === "LIVE") {
            authRecoveryAttemptsRef.current = [];
          }
          await syncToCanonicalTime({
            forceHardSeek: true,
          });
        } catch (error) {
          console.error(error);
          if (!cancelled) {
            const message =
              error instanceof Error ? error.message.toLowerCase() : "";
            const errorClass: HlsRecoveryErrorClass =
              message.includes("403") || message.includes("401")
                ? "AUTH_SUSPECTED"
                : "NETWORK_OR_PARSE";
            updateLastErrorClass(errorClass);
            if (phaseRef.current === "LIVE") {
              void attemptRecovery(errorClass);
            } else {
              setStatusIfChanged("Unable to initialize HLS stream.");
            }
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
      updateLastErrorClass,
      updateRecoveryState,
      attemptRecovery,
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

    useEffect(() => {
      if (!isPlayerReady || !hasAccess || phase !== "LIVE" || recoveryState === "DEGRADED") {
        return;
      }

      const timer = window.setInterval(() => {
        const adapter = adapterRef.current;
        if (!adapter || !isPlaying || bufferingRef.current) {
          return;
        }

        const idleMs = Date.now() - lastProgressAtRef.current;
        if (idleMs < NO_PROGRESS_WATCHDOG_MS) {
          return;
        }

        if (adapter.getReadyState() >= 3 && !adapter.isBuffering()) {
          return;
        }

        void attemptRecovery("MEDIA_STALL");
      }, 1000);

      return () => window.clearInterval(timer);
    }, [
      attemptRecovery,
      hasAccess,
      isPlayerReady,
      isPlaying,
      phase,
      recoveryState,
    ]);

    useEffect(() => {
      if (
        !isPlayerReady ||
        !hasAccess ||
        phase !== "LIVE" ||
        !tokenExpiresAtRef.current ||
        recoveryState === "DEGRADED"
      ) {
        return;
      }

      const timer = window.setInterval(() => {
        if (recoveryInFlightRef.current) {
          return;
        }

        const nowWithServerOffset = Date.now() + serverOffsetRef.current;
        const msUntilExpiry = tokenExpiresAtRef.current! - nowWithServerOffset;
        if (msUntilExpiry > PREEMPTIVE_REFRESH_THRESHOLD_MS) {
          return;
        }
        if (Date.now() - lastTokenRefreshAtRef.current < TOKEN_REFRESH_COOLDOWN_MS) {
          return;
        }

        lastTokenRefreshAtRef.current = Date.now();
        void (async () => {
          try {
            updateRecoveryState("RECOVERING");
            setStatusIfChanged("Refreshing stream token...");
            const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
            const refreshedUrl =
              refreshed?.finalManifestUrl ?? finalManifestUrlRef.current;
            if (refreshed?.tokenExpiresAtUnixMs) {
              tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
            }
            if (!refreshedUrl) {
              throw new Error("Missing refreshed manifest URL.");
            }
            await reinitializeWithUrl(refreshedUrl, {
              announce: "Refreshing stream token...",
              readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
            });
            updateRecoveryState("IDLE");
            setStatusIfChanged("Live playback synchronized.");
          } catch (error) {
            console.error(error);
            void attemptRecovery("AUTH_SUSPECTED");
          }
        })();
      }, 15_000);

      return () => window.clearInterval(timer);
    }, [
      attemptRecovery,
      hasAccess,
      isPlayerReady,
      phase,
      reinitializeWithUrl,
      recoveryState,
      setStatusIfChanged,
      updateRecoveryState,
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

    const handleManualRecoveryRetry = useCallback(async () => {
      authRecoveryAttemptsRef.current = [];
      networkRecoveryStepRef.current = 0;
      updateLastErrorClass(null);
      updateRecoveryState("IDLE");
      lastProgressAtRef.current = Date.now();
      lastKnownCurrentTimeRef.current = 0;
      const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
      const nextUrl = refreshed?.finalManifestUrl ?? finalManifestUrlRef.current;
      if (refreshed?.tokenExpiresAtUnixMs) {
        tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
      }
      if (!nextUrl) {
        enterDegradedState(
          "NETWORK_OR_PARSE",
          "Playback issue - Retry to reconnect stream.",
        );
        return;
      }

      try {
        await reinitializeWithUrl(nextUrl, {
          announce: "Retrying stream...",
          readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
        });
        setStatusIfChanged("Stream recovered.");
        updateRecoveryState("IDLE");
      } catch (error) {
        console.error(error);
        enterDegradedState(
          "NETWORK_OR_PARSE",
          "Playback issue - Retry to reconnect stream.",
        );
      }
    }, [
      enterDegradedState,
      reinitializeWithUrl,
      setStatusIfChanged,
      updateLastErrorClass,
      updateRecoveryState,
    ]);

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
    const showRecoveryOverlay = showPlayer && recoveryState === "DEGRADED";

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
            {showRecoveryOverlay ? (
              <div className="video-prime-overlay">
                <p>Playback issue - Retry</p>
                <button type="button" onClick={() => void handleManualRecoveryRetry()}>
                  Retry Playback
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
