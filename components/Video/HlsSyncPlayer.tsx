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
  PlaybackStartState,
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
const SEEK_SETTLE_TIMEOUT_MS = 1500;
const SEEK_SETTLE_TIMEOUT_LOW_READY_MS = 3000;
const SEEK_SETTLE_EPSILON_SEC = 0.35;
const SHORT_PROGRESS_CHECK_MS = 2500;
const SHORT_PROGRESS_DELTA_MIN_SEC = 0.1;
const LIVE_PAUSE_RESUME_COOLDOWN_MS = 2000;

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

function isAutoplayBlockedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === "NotAllowedError") {
    return true;
  }

  if (error.name === "AbortError") {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("user didn't interact") ||
    message.includes("user did not interact") ||
    message.includes("interaction") ||
    message.includes("notallowederror")
  );
}

function isIosSafariBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(ua);
  return isIOS && isSafari;
}

function statusTextForPlaybackStartState(state: PlaybackStartState): string {
  if (state === "PRIMING_REQUIRED") {
    return "Tap to enable playback.";
  }
  if (state === "STARTING") {
    return "Starting...";
  }
  if (state === "CANONICAL_SEEKED") {
    return "Syncing...";
  }
  if (state === "BUFFERING") {
    return "Buffering stream...";
  }
  if (state === "BLOCKED_AUTOPLAY") {
    return "Tap to play.";
  }
  if (state === "DEGRADED") {
    return "Playback issue - Retry";
  }
  if (state === "PLAYING") {
    return "Live playback synchronized.";
  }
  return "Loading stream...";
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
    const lastDebugSignatureRef = useRef<string>("");
    const recoveryStateRef = useRef<HlsRecoveryState>("IDLE");
    const playbackStartStateRef = useRef<PlaybackStartState>("IDLE");
    const autoplayBlockedRef = useRef(false);
    const lastErrorClassRef = useRef<HlsRecoveryErrorClass | null>(null);
    const playIntentRef = useRef(false);
    const startupAttemptIdRef = useRef(0);
    const activeStartupAttemptRef = useRef(0);
    const startupPlayingSinceRef = useRef<number | null>(null);
    const shortProgressCheckTimerRef = useRef<number | null>(null);
    const livePauseResumeTimerRef = useRef<number | null>(null);
    const livePauseCooldownUntilRef = useRef(0);
    const authRecoveryAttemptsRef = useRef<number[]>([]);
    const networkRecoveryStepRef = useRef<0 | 1 | 2>(0);
    const lastProgressAtRef = useRef<number>(Date.now());
    const lastKnownCurrentTimeRef = useRef<number>(0);
    const lastTokenRefreshAtRef = useRef<number>(0);
    const skipEffectInitUrlRef = useRef<string | null>(null);
    const syncToCanonicalTimeRef = useRef<(options?: SyncOptions) => Promise<void>>(
      async () => {},
    );
    const startPlaybackFromCanonicalRef = useRef<
      (options?: { forceHardSeek?: boolean; userGesture?: boolean }) => Promise<void>
    >(async () => {});
    const recoverFromPlaybackFailureRef = useRef<
      (error: HlsFatalError) => Promise<void>
    >(async () => {});
    const shouldAllowBufferingStateRef = useRef<() => boolean>(() => false);
    const updatePlaybackStartStateRef = useRef<
      (next: PlaybackStartState, options?: { keepStatus?: boolean }) => void
    >(() => {});
    const stopDriftLoopRef = useRef<() => void>(() => {});
    const setStatusIfChangedRef = useRef<(nextStatus: string) => void>(() => {});

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
    const [playbackStartState, setPlaybackStartState] =
      useState<PlaybackStartState>("IDLE");
    const [autoplayBlocked, setAutoplayBlocked] = useState(false);
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
    playbackStartStateRef.current = playbackStartState;
    autoplayBlockedRef.current = autoplayBlocked;
    lastErrorClassRef.current = lastErrorClass;

    const publishDebugState = useCallback(
      (patch?: Partial<VideoSyncDebugState>) => {
        const onDebugStateChangeCurrent = onDebugStateChangeRef.current;
        if (!onDebugStateChangeCurrent) {
          return;
        }

        const currentDriftDebug = driftDebugRef.current;
        const adapter = adapterRef.current;
        const nextDebugState: VideoSyncDebugState = {
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
          playbackStartState: playbackStartStateRef.current,
          autoplayBlocked: autoplayBlockedRef.current,
          playIntentActive: playIntentRef.current,
          ...patch,
        };

        const nextSignature = JSON.stringify(nextDebugState);
        if (nextSignature === lastDebugSignatureRef.current) {
          return;
        }
        lastDebugSignatureRef.current = nextSignature;
        onDebugStateChangeCurrent(nextDebugState);
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

    const updatePlaybackStartState = useCallback(
      (next: PlaybackStartState, options?: { keepStatus?: boolean }) => {
        playbackStartStateRef.current = next;
        setPlaybackStartState(next);
        if (!options?.keepStatus) {
          setStatusIfChanged(statusTextForPlaybackStartState(next));
        }
      },
      [setStatusIfChanged],
    );

    const setAutoplayBlockedState = useCallback((next: boolean) => {
      autoplayBlockedRef.current = next;
      setAutoplayBlocked(next);
    }, []);

    const clearShortProgressCheck = useCallback(() => {
      if (shortProgressCheckTimerRef.current) {
        window.clearTimeout(shortProgressCheckTimerRef.current);
        shortProgressCheckTimerRef.current = null;
      }
    }, []);

    const beginStartupAttempt = useCallback(() => {
      const nextAttempt = startupAttemptIdRef.current + 1;
      startupAttemptIdRef.current = nextAttempt;
      activeStartupAttemptRef.current = nextAttempt;
      return nextAttempt;
    }, []);

    const invalidateStartupAttempt = useCallback(() => {
      const nextAttempt = startupAttemptIdRef.current + 1;
      startupAttemptIdRef.current = nextAttempt;
      activeStartupAttemptRef.current = 0;
      clearShortProgressCheck();
    }, [clearShortProgressCheck]);

    const isStartupAttemptActive = useCallback((attemptId: number) => {
      return (
        attemptId !== 0 &&
        attemptId === startupAttemptIdRef.current &&
        attemptId === activeStartupAttemptRef.current
      );
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

    const computeTargetTimeSec = useCallback(() => {
      const activeScreening = screeningRef.current;
      if (!activeScreening) {
        return 0;
      }

      const rawTargetSec =
        (Date.now() + serverOffsetRef.current - activeScreening.premiereStartUnixMs) /
        1000;
      return clampPlaybackTargetSec(rawTargetSec, activeScreening.filmDurationSec);
    }, []);

    const getSeekSettleTimeoutMs = useCallback(() => {
      const video = videoRef.current;
      if (!video) {
        return SEEK_SETTLE_TIMEOUT_LOW_READY_MS;
      }

      const lowReadiness = video.readyState < 2 || video.seekable.length === 0;
      if (lowReadiness || isIosSafariBrowser()) {
        return SEEK_SETTLE_TIMEOUT_LOW_READY_MS;
      }

      return SEEK_SETTLE_TIMEOUT_MS;
    }, []);

    const waitForSeekSettled = useCallback(
      async (attemptId: number, targetTime: number): Promise<void> => {
        const video = videoRef.current;
        if (!video) {
          return;
        }

        const timeoutMs = getSeekSettleTimeoutMs();
        const startedAt = Date.now();

        await new Promise<void>((resolve) => {
          const settle = () => {
            video.removeEventListener("seeked", onSeeked);
            resolve();
          };

          const onSeeked = () => {
            if (!isStartupAttemptActive(attemptId)) {
              settle();
              return;
            }
            if (Math.abs(video.currentTime - targetTime) <= SEEK_SETTLE_EPSILON_SEC) {
              settle();
            }
          };

          video.addEventListener("seeked", onSeeked);

          const poll = () => {
            if (!isStartupAttemptActive(attemptId)) {
              settle();
              return;
            }

            if (Math.abs(video.currentTime - targetTime) <= SEEK_SETTLE_EPSILON_SEC) {
              settle();
              return;
            }

            if (Date.now() - startedAt >= timeoutMs) {
              settle();
              return;
            }

            window.setTimeout(poll, 60);
          };

          poll();
        });
      },
      [getSeekSettleTimeoutMs, isStartupAttemptActive],
    );

    const shouldAllowBufferingState = useCallback(() => {
      if (phaseRef.current !== "LIVE" || !playIntentRef.current) {
        return false;
      }

      const state = playbackStartStateRef.current;
      return state === "STARTING" || state === "PLAYING";
    }, []);

    const scheduleShortProgressCheck = useCallback(
      (attemptId: number, fromTime: number) => {
        clearShortProgressCheck();
        shortProgressCheckTimerRef.current = window.setTimeout(() => {
          if (!isStartupAttemptActive(attemptId)) {
            return;
          }
          if (phaseRef.current !== "LIVE" || !playIntentRef.current) {
            return;
          }

          const video = videoRef.current;
          if (!video) {
            return;
          }

          if (playbackStartStateRef.current !== "PLAYING") {
            return;
          }

          if (video.currentTime - fromTime >= SHORT_PROGRESS_DELTA_MIN_SEC) {
            return;
          }

          bufferingRef.current = true;
          setBuffering(true);
          updatePlaybackStartState("BUFFERING");
          stopDriftLoop();
          publishDebugState({
            buffering: true,
          });
        }, SHORT_PROGRESS_CHECK_MS);
      },
      [
        clearShortProgressCheck,
        isStartupAttemptActive,
        publishDebugState,
        stopDriftLoop,
        updatePlaybackStartState,
      ],
    );

    const syncToCanonicalTime = useCallback(
      async (options?: SyncOptions) => {
        const adapter = adapterRef.current;
        if (!adapter || !screeningRef.current) {
          return;
        }

        try {
          await adapter.waitUntilReady(READY_TIMEOUT_MS);
        } catch {
          setStatusIfChanged("Player is not ready yet.");
          return;
        }

        const targetTime = computeTargetTimeSec();
        const currentPhase = phaseRef.current;

        if (currentPhase === "WAITING") {
          playIntentRef.current = false;
          softCorrectionStartedAtRef.current = null;
          liveAlignmentDoneRef.current = false;
          await adapter.pause();
          await adapter.seekTo(0);
          bufferingRef.current = false;
          setBuffering(false);
          setAutoplayBlockedState(false);
          clearShortProgressCheck();
          updatePlaybackStartState("IDLE", {
            keepStatus: true,
          });
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
          playIntentRef.current = false;
          softCorrectionStartedAtRef.current = null;
          await adapter.pause();
          bufferingRef.current = false;
          setBuffering(false);
          clearShortProgressCheck();
          updatePlaybackStartState("IDLE", {
            keepStatus: true,
          });
          setStatusIfChanged("Silence interval in progress.");
          publishDebugState({
            targetTime,
          });
          return;
        }

        if (currentPhase === "DISCUSSION" || currentPhase === "CLOSED") {
          playIntentRef.current = false;
          softCorrectionStartedAtRef.current = null;
          await adapter.pause();
          bufferingRef.current = false;
          setBuffering(false);
          clearShortProgressCheck();
          updatePlaybackStartState("IDLE", {
            keepStatus: true,
          });
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
          playIntentRef.current = false;
          await adapter.pause();
          setAutoplayBlockedState(false);
          bufferingRef.current = false;
          setBuffering(false);
          clearShortProgressCheck();
          updatePlaybackStartState("PRIMING_REQUIRED");
          publishDebugState({
            targetTime,
          });
          return;
        }

        if (
          playbackStartStateRef.current === "PRIMING_REQUIRED" ||
          playbackStartStateRef.current === "BLOCKED_AUTOPLAY" ||
          playbackStartStateRef.current === "DEGRADED"
        ) {
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
          if (shouldAllowBufferingState()) {
            bufferingRef.current = true;
            setBuffering(true);
            updatePlaybackStartState("BUFFERING");
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

        if (Date.now() < livePauseCooldownUntilRef.current) {
          publishDebugState({
            playerTime: currentTime,
            targetTime,
            drift,
          });
          return;
        }

        if (playIntentRef.current) {
          try {
            await adapter.play();
          } catch (error) {
            if (isAutoplayBlockedError(error)) {
              setAutoplayBlockedState(true);
              bufferingRef.current = false;
              setBuffering(false);
              clearShortProgressCheck();
              updatePlaybackStartState("BLOCKED_AUTOPLAY");
              stopDriftLoop();
              publishDebugState({
                targetTime,
                buffering: false,
                playbackStartState: "BLOCKED_AUTOPLAY",
                autoplayBlocked: true,
              });
              return;
            }
            throw error;
          }
        }

        setAutoplayBlockedState(false);
        bufferingRef.current = false;
        setBuffering(false);
        if (
          playbackStartStateRef.current === "STARTING" ||
          playbackStartStateRef.current === "CANONICAL_SEEKED" ||
          playbackStartStateRef.current === "BUFFERING"
        ) {
          updatePlaybackStartState("PLAYING");
        } else {
          setStatusIfChanged("Live playback synchronized.");
        }
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
        clearShortProgressCheck,
        computeTargetTimeSec,
        publishDebugState,
        requiresPriming,
        setAutoplayBlockedState,
        setStatusIfChanged,
        shouldAllowBufferingState,
        stopDriftLoop,
        updatePlaybackStartState,
        updateRecoveryState,
      ],
    );

    const startPlaybackFromCanonical = useCallback(
      async (options?: { forceHardSeek?: boolean; userGesture?: boolean }) => {
        const adapter = adapterRef.current;
        const activeScreening = screeningRef.current;
        const video = videoRef.current;
        if (!adapter || !activeScreening || !video) {
          return;
        }

        const attemptId = beginStartupAttempt();
        playIntentRef.current = true;
        setAutoplayBlockedState(false);
        bufferingRef.current = false;
        setBuffering(false);
        clearShortProgressCheck();

        if (requiresPriming && !playPrimedRef.current) {
          playIntentRef.current = false;
          updatePlaybackStartState("PRIMING_REQUIRED");
          stopDriftLoop();
          await adapter.pause();
          publishDebugState({
            playbackStartState: "PRIMING_REQUIRED",
            playIntentActive: false,
          });
          return;
        }

        updatePlaybackStartState("STARTING");

        try {
          await adapter.waitUntilReady(READY_TIMEOUT_MS);
          if (!isStartupAttemptActive(attemptId)) {
            return;
          }

          const targetTime = computeTargetTimeSec();
          await adapter.seekTo(targetTime);
          await waitForSeekSettled(attemptId, targetTime);
          if (!isStartupAttemptActive(attemptId)) {
            return;
          }

          liveAlignmentDoneRef.current = true;
          updatePlaybackStartState("CANONICAL_SEEKED");

          if (!options?.userGesture && !video.muted) {
            video.muted = true;
            setIsMuted(true);
          }

          if (options?.userGesture) {
            await video.play();
          } else {
            await adapter.play();
          }

          if (!isStartupAttemptActive(attemptId)) {
            return;
          }

          setAutoplayBlockedState(false);
          updatePlaybackStartState("PLAYING");
          lastResyncAtRef.current = Date.now();
          startupPlayingSinceRef.current = Date.now();
          const playerNow = await adapter.getCurrentTime();
          scheduleShortProgressCheck(attemptId, playerNow);
          publishDebugState({
            playerTime: playerNow,
            targetTime,
            drift: playerNow - targetTime,
            lastResyncAt: lastResyncAtRef.current,
            playbackStartState: "PLAYING",
            autoplayBlocked: false,
            playIntentActive: true,
          });

          await syncToCanonicalTime({
            forceHardSeek: options?.forceHardSeek,
          });
        } catch (error) {
          if (!isStartupAttemptActive(attemptId)) {
            return;
          }

          if (isAutoplayBlockedError(error)) {
            playIntentRef.current = false;
            setAutoplayBlockedState(true);
            updatePlaybackStartState("BLOCKED_AUTOPLAY");
            stopDriftLoop();
            publishDebugState({
              playbackStartState: "BLOCKED_AUTOPLAY",
              autoplayBlocked: true,
              playIntentActive: false,
            });
            return;
          }

          throw error;
        }
      },
      [
        beginStartupAttempt,
        clearShortProgressCheck,
        computeTargetTimeSec,
        isStartupAttemptActive,
        publishDebugState,
        requiresPriming,
        scheduleShortProgressCheck,
        setAutoplayBlockedState,
        stopDriftLoop,
        syncToCanonicalTime,
        updatePlaybackStartState,
        waitForSeekSettled,
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

        invalidateStartupAttempt();
        stopDriftLoop();
        setIsPlayerReady(false);
        clearShortProgressCheck();
        finalManifestUrlRef.current = nextManifestUrl;
        skipEffectInitUrlRef.current = nextManifestUrl;
        await adapter.initialize(videoElement, nextManifestUrl);
        await adapter.waitUntilReady(options?.readyTimeoutMs ?? RECOVERY_READY_TIMEOUT_MS);
        setIsPlayerReady(true);
        setReadyState(adapter.getReadyState());
        liveAlignmentDoneRef.current = false;
        lastResyncAtRef.current = Date.now();
        if (phaseRef.current === "LIVE") {
          await startPlaybackFromCanonical({
            forceHardSeek: true,
          });
        } else {
          await syncToCanonicalTime({
            forceHardSeek: true,
          });
        }
        publishDebugState({
          lastResyncAt: lastResyncAtRef.current,
        });
      },
      [
        clearShortProgressCheck,
        invalidateStartupAttempt,
        publishDebugState,
        setStatusIfChanged,
        startPlaybackFromCanonical,
        stopDriftLoop,
        syncToCanonicalTime,
      ],
    );

    const enterDegradedState = useCallback(
      (errorClass: HlsRecoveryErrorClass, message: string) => {
        playIntentRef.current = false;
        setAutoplayBlockedState(false);
        updateLastErrorClass(errorClass);
        updateRecoveryState("DEGRADED");
        updatePlaybackStartState("DEGRADED", {
          keepStatus: true,
        });
        setStatusIfChanged(message);
        clearShortProgressCheck();
        stopDriftLoop();
      },
      [
        clearShortProgressCheck,
        setAutoplayBlockedState,
        setStatusIfChanged,
        stopDriftLoop,
        updateLastErrorClass,
        updatePlaybackStartState,
        updateRecoveryState,
      ],
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
          playIntentRef.current = false;
          setAutoplayBlockedState(false);
          updatePlaybackStartState("IDLE", {
            keepStatus: true,
          });
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
      [
        attemptRecovery,
        setAutoplayBlockedState,
        setStatusIfChanged,
        updatePlaybackStartState,
      ],
    );

    syncToCanonicalTimeRef.current = syncToCanonicalTime;
    startPlaybackFromCanonicalRef.current = startPlaybackFromCanonical;
    recoverFromPlaybackFailureRef.current = recoverFromPlaybackFailure;
    shouldAllowBufferingStateRef.current = shouldAllowBufferingState;
    updatePlaybackStartStateRef.current = updatePlaybackStartState;
    stopDriftLoopRef.current = stopDriftLoop;
    setStatusIfChangedRef.current = setStatusIfChanged;

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
      setAutoplayBlockedState(false);
      updatePlaybackStartState("IDLE", {
        keepStatus: true,
      });
      invalidateStartupAttempt();
    }, [
      invalidateStartupAttempt,
      room,
      setAutoplayBlockedState,
      updatePlaybackStartState,
    ]);

    useEffect(() => {
      const video = videoRef.current;
      if (!video) {
        return;
      }

      video.setAttribute("playsinline", "true");
      video.setAttribute("webkit-playsinline", "true");

      const onTimeUpdate = () => {
        const nextTime = video.currentTime || 0;
        if (nextTime > lastKnownCurrentTimeRef.current + 0.05) {
          lastProgressAtRef.current = Date.now();
          lastKnownCurrentTimeRef.current = nextTime;
        }
        setPlayerTime((current) =>
          Math.abs(current - nextTime) >= 0.05 ? nextTime : current,
        );
        const nextDuration = video.duration || 0;
        setPlayerDuration((current) =>
          Math.abs(current - nextDuration) >= 0.1 ? nextDuration : current,
        );
      };
      const onPlay = () => {
        setIsPlaying(true);
        lastProgressAtRef.current = Date.now();
      };
      const onPause = () => {
        setIsPlaying(false);
        if (phaseRef.current !== "LIVE" || !playIntentRef.current) {
          return;
        }

        if (Date.now() < livePauseCooldownUntilRef.current) {
          return;
        }

        livePauseCooldownUntilRef.current = Date.now() + LIVE_PAUSE_RESUME_COOLDOWN_MS;
        setStatusIfChangedRef.current("Live playback resumes automatically.");
        if (livePauseResumeTimerRef.current) {
          window.clearTimeout(livePauseResumeTimerRef.current);
          livePauseResumeTimerRef.current = null;
        }
        livePauseResumeTimerRef.current = window.setTimeout(() => {
          if (phaseRef.current !== "LIVE" || !playIntentRef.current || !video.paused) {
            return;
          }
          void startPlaybackFromCanonicalRef.current({
            forceHardSeek: false,
          });
        }, LIVE_PAUSE_RESUME_COOLDOWN_MS);
      };
      const onVolumeChange = () => {
        setIsMuted(video.muted);
        setVolume(video.volume);
      };
      const onReadyStateEvent = () => {
        setReadyState(video.readyState);
      };
      const onWaiting = () => {
        if (!shouldAllowBufferingStateRef.current()) {
          return;
        }
        bufferingRef.current = true;
        setBuffering(true);
        updatePlaybackStartStateRef.current("BUFFERING");
        stopDriftLoopRef.current();
      };
      const onRecovered = () => {
        if (!bufferingRef.current) {
          return;
        }
        bufferingRef.current = false;
        setBuffering(false);
        if (phaseRef.current === "LIVE") {
          if (playIntentRef.current) {
            updatePlaybackStartStateRef.current("PLAYING");
          }
          void (async () => {
            await syncToCanonicalTimeRef.current({
              forceHardSeek: true,
            });
          })();
          return;
        }
        if (phaseRef.current === "WAITING") {
          setStatusIfChangedRef.current("Waiting for stream to begin.");
        }
      };
      const onError = () => {
        void recoverFromPlaybackFailureRef.current({
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
        if (livePauseResumeTimerRef.current) {
          window.clearTimeout(livePauseResumeTimerRef.current);
          livePauseResumeTimerRef.current = null;
        }
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
          setAutoplayBlockedState(false);
          updatePlaybackStartState("IDLE");
          clearShortProgressCheck();
          invalidateStartupAttempt();
          playIntentRef.current = false;
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
            await startPlaybackFromCanonical({
              forceHardSeek: true,
            });
            return;
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
            updatePlaybackStartState("IDLE", {
              keepStatus: true,
            });
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
        invalidateStartupAttempt();
        clearShortProgressCheck();
        stopDriftLoop();
        setIsPlayerReady(false);
        void adapter.destroy();
      };
    }, [
      clearShortProgressCheck,
      finalManifestUrl,
      hasAccess,
      invalidateStartupAttempt,
      playbackConfigError,
      recoverFromPlaybackFailure,
      screening,
      setAutoplayBlockedState,
      setStatusIfChanged,
      startPlaybackFromCanonical,
      stopDriftLoop,
      syncToCanonicalTime,
      updateLastErrorClass,
      updatePlaybackStartState,
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
        if (phase === "LIVE") {
          void startPlaybackFromCanonical({
            forceHardSeek: false,
          });
          return;
        }
        void syncToCanonicalTime();
      }, 0);
      return () => window.clearTimeout(timer);
    }, [isPlayerReady, phase, startPlaybackFromCanonical, syncToCanonicalTime]);

    useEffect(() => {
      const adapter = adapterRef.current;
      const canRunLoop =
        Boolean(adapter) &&
        isPlayerReady &&
        hasAccess &&
        phase === "LIVE" &&
        playIntentRef.current &&
        playbackStartStateRef.current === "PLAYING" &&
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
      playbackStartState,
      phase,
      publishDebugState,
      stopDriftLoop,
      syncToCanonicalTime,
    ]);

    useEffect(() => {
      if (
        !isPlayerReady ||
        !hasAccess ||
        phase !== "LIVE" ||
        recoveryState === "DEGRADED" ||
        !playIntentRef.current
      ) {
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
      playbackStartState,
      recoveryState,
    ]);

    useEffect(() => {
      if (
        !isPlayerReady ||
        !hasAccess ||
        phase !== "LIVE" ||
        !tokenExpiresAtRef.current ||
        recoveryState === "DEGRADED" ||
        !playIntentRef.current
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
      playbackStartState,
      reinitializeWithUrl,
      recoveryState,
      setStatusIfChanged,
      updateRecoveryState,
    ]);

    const handleOverlayPlaybackTap = useCallback(() => {
      const video = videoRef.current;
      const adapter = adapterRef.current;
      if (!video || !adapter) {
        setStatusText("Player is not ready for playback.");
        return;
      }

      video.muted = true;
      setIsMuted(true);

      const playPromise = video.play();
      const attemptId = beginStartupAttempt();
      activeStartupAttemptRef.current = attemptId;
      playIntentRef.current = true;
      setAutoplayBlockedState(false);
      clearShortProgressCheck();

      void (async () => {
        try {
          await playPromise;
          if (!isStartupAttemptActive(attemptId)) {
            return;
          }

          setPrimed(true);
          updatePlaybackStartState("PLAYING");
          startupPlayingSinceRef.current = Date.now();
          const playerNow = await adapter.getCurrentTime();
          scheduleShortProgressCheck(attemptId, playerNow);

          if (phaseRef.current === "WAITING") {
            window.setTimeout(() => {
              void adapter.pause();
            }, 150);
            setStatusIfChanged("Playback primed. Ready for LIVE start.");
            return;
          }

          await syncToCanonicalTime({
            forceHardSeek: true,
          });
        } catch (error) {
          console.error(error);
          if (isAutoplayBlockedError(error)) {
            setAutoplayBlockedState(true);
            playIntentRef.current = false;
            updatePlaybackStartState(
              requiresPriming ? "PRIMING_REQUIRED" : "BLOCKED_AUTOPLAY",
            );
            stopDriftLoop();
            return;
          }
          setStatusIfChanged("Playback start failed. Tap again.");
        }
      })();
    }, [
      beginStartupAttempt,
      clearShortProgressCheck,
      isStartupAttemptActive,
      requiresPriming,
      scheduleShortProgressCheck,
      setAutoplayBlockedState,
      setPrimed,
      setStatusIfChanged,
      stopDriftLoop,
      syncToCanonicalTime,
      updatePlaybackStartState,
    ]);

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
      updatePlaybackStartState("STARTING");
      setAutoplayBlockedState(false);
      playIntentRef.current = true;
      clearShortProgressCheck();
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
      clearShortProgressCheck,
      enterDegradedState,
      reinitializeWithUrl,
      setAutoplayBlockedState,
      setStatusIfChanged,
      updateLastErrorClass,
      updatePlaybackStartState,
      updateRecoveryState,
    ]);

    const showPlayer =
      hasAccess &&
      screening?.videoProvider === "hls" &&
      phase !== "DISCUSSION" &&
      phase !== "CLOSED" &&
      !playbackConfigError;

    const shouldShowPrimingOverlay =
      showPlayer &&
      phase !== "SILENCE" &&
      (playbackStartState === "PRIMING_REQUIRED" ||
        (requiresPriming &&
          !isPrimed &&
          (phase === "WAITING" || phase === "LIVE")));
    const shouldShowBlockedAutoplayOverlay =
      showPlayer && playbackStartState === "BLOCKED_AUTOPLAY";
    const scrubEnabled =
      rehearsalScrubEnabled && phase !== "LIVE" && phase !== "SILENCE" && showPlayer;
    const showRecoveryOverlay = showPlayer && recoveryState === "DEGRADED";
    const showPlaybackStartOverlay =
      shouldShowPrimingOverlay || shouldShowBlockedAutoplayOverlay;
    const playbackStartOverlayLabel =
      playbackStartState === "BLOCKED_AUTOPLAY" ? "Tap to play" : "Tap to enable playback";
    const playbackStartOverlayButton =
      playbackStartState === "BLOCKED_AUTOPLAY" ? "Play" : "Enable Playback";

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
            {showPlaybackStartOverlay ? (
              <div className="video-prime-overlay">
                <p>{playbackStartOverlayLabel}</p>
                <button type="button" onClick={handleOverlayPlaybackTap}>
                  {playbackStartOverlayButton}
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
