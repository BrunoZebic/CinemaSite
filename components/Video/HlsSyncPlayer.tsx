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
import type { HlsPlaybackEngine } from "@/lib/video/hlsEngineSelection";

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
// Treat auth failures within this window as a reason to refresh before startup.
const AUTH_RECENT_WINDOW_MS = 180_000;
const STARTUP_ON_DEMAND_REFRESH_THRESHOLD_MS = 30_000;
const PENDING_REFRESH_MAX_AGE_MS = 60_000;
const AUTH_RECOVERY_WINDOW_MS = 30_000;
const AUTH_RECOVERY_MAX_ATTEMPTS = 2;
const SEEK_SETTLE_TIMEOUT_MS = 1500;
const SEEK_SETTLE_TIMEOUT_LOW_READY_MS = 3000;
const SEEK_SETTLE_EPSILON_SEC = 0.35;
const SHORT_PROGRESS_CHECK_MS = 2500;
const SHORT_PROGRESS_DELTA_MIN_SEC = 0.1;
const LIVE_PAUSE_RESUME_COOLDOWN_MS = 2000;
const GESTURE_OVERLAY_ACCEPT_MS = 80;
const GESTURE_OVERLAY_EXIT_MS = 240;
const shouldExposeHlsE2EProbe =
  process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_E2E === "1";

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

type GestureOverlayPhase = "idle" | "accepting" | "exiting";
type OperationOwner = "none" | "startup" | "token_refresh" | "recovery";
type PendingReinitReason = "token_refresh" | "recovery" | null;
type LastPlayAttempt =
  | "attempted"
  | "video_play_ok"
  | `video_play_failed:${string}`;
type HlsE2EProbeState = {
  playbackEngine: HlsPlaybackEngine;
  manifestParsed: boolean;
  nativeMetadataLoaded: boolean;
  readinessStage: string;
  readyState: number;
  buffering: boolean;
  recoveryState: HlsRecoveryState;
  playbackStartState: PlaybackStartState;
  autoplayBlocked: boolean;
  playIntentActive: boolean;
  operationOwner: OperationOwner;
  reinitLocked: boolean;
  pendingReinitReason: PendingReinitReason;
  requiresPriming: boolean;
  isPrimed: boolean;
  startupAttemptId: number;
  gestureTapCount: number;
  lastGestureAtMs: number | null;
  lastPlayAttempt: LastPlayAttempt | null;
  startupCalledFromGesture: boolean;
};

declare global {
  interface Window {
    __HLS_E2E_PROBE__?: HlsE2EProbeState;
  }
}

function getPrimingKey(room: string): string {
  return `playPrimed:${room}`;
}

function classifyFatalError(error: HlsFatalError): HlsRecoveryErrorClass {
  if (error.isForbidden || error.statusCode === 401 || error.statusCode === 403) {
    return "AUTH_SUSPECTED";
  }
  return "NETWORK_OR_PARSE";
}

function isAuthSuspectedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : error ? String(error) : "";
  return /401|403|forbidden|token|unauthori[sz]ed/i.test(message);
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

function getPlayAttemptRank(value: LastPlayAttempt | null): number {
  if (value === null) {
    return 0;
  }
  if (value === "attempted") {
    return 1;
  }
  return 2;
}

function toFailedPlayAttempt(error: unknown): LastPlayAttempt {
  const errorName =
    error instanceof Error && error.name.trim().length > 0
      ? error.name.trim()
      : "UnknownError";
  return `video_play_failed:${errorName}`;
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
    const gestureOverlayAcceptTimerRef = useRef<number | null>(null);
    const gestureOverlayExitTimerRef = useRef<number | null>(null);
    const gestureTapInFlightRef = useRef(false);
    const gestureTapCountRef = useRef(0);
    const lastGestureAtMsRef = useRef<number | null>(null);
    const lastPlayAttemptRef = useRef<LastPlayAttempt | null>(null);
    const startupCalledFromGestureRef = useRef(false);
    const livePauseResumeTimerRef = useRef<number | null>(null);
    const livePauseCooldownUntilRef = useRef(0);
    const authRecoveryAttemptsRef = useRef<number[]>([]);
    const networkRecoveryStepRef = useRef<0 | 1 | 2>(0);
    const lastProgressAtRef = useRef<number>(Date.now());
    const lastKnownCurrentTimeRef = useRef<number>(0);
    const lastTokenRefreshAtRef = useRef<number>(0);
    const lastAuthErrorAtMsRef = useRef<number>(0);
    const reinitLockRef = useRef(false);
    const pendingReinitRequestedRef = useRef(false);
    const pendingReinitReasonRef = useRef<PendingReinitReason>(null);
    const pendingReinitRequestedAtRef = useRef<number | null>(null);
    const operationOwnerRef = useRef<OperationOwner>("none");
    const isPlayerReadyRef = useRef(false);
    const drainPendingReinitRef = useRef<() => void>(() => {});
    const skipEffectInitUrlRef = useRef<string | null>(null);
    const syncToCanonicalTimeRef = useRef<(options?: SyncOptions) => Promise<void>>(
      async () => {},
    );
    const startPlaybackFromCanonicalRef = useRef<
      (
        options?: {
          forceHardSeek?: boolean;
          skipOnDemandRefresh?: boolean;
          fromGesture?: boolean;
        },
      ) => Promise<void>
    >(async () => {});
    const reinitializeWithUrlRef = useRef<
      (
        nextManifestUrl: string,
        options?: {
          readyTimeoutMs?: number;
        },
      ) => Promise<void>
    >(async () => {});
    const recoverFromPlaybackFailureRef = useRef<
      (error: HlsFatalError) => Promise<void>
    >(async () => {});
    const attemptRecoveryRef = useRef<
      (errorClass: HlsRecoveryErrorClass) => Promise<void>
    >(async () => {});
    const runPreemptiveRefreshRef = useRef<() => Promise<void>>(async () => {});
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
    const [isGestureOverlayMounted, setIsGestureOverlayMounted] = useState(false);
    const [gestureOverlayPhase, setGestureOverlayPhase] =
      useState<GestureOverlayPhase>("idle");
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
    isPlayerReadyRef.current = isPlayerReady;
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
        const playbackEngine = adapter?.getPlaybackEngine() ?? "unsupported";
        const manifestParsed = adapter?.isManifestParsed() ?? false;
        const nativeMetadataLoaded = adapter?.isNativeMetadataLoaded() ?? false;
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
          playbackEngine,
          manifestParsed,
          nativeMetadataLoaded,
          recoveryState: recoveryStateRef.current,
          recoveryAttemptsWindow: `auth:${authRecoveryAttemptsRef.current.length}/${AUTH_RECOVERY_MAX_ATTEMPTS} net:${networkRecoveryStepRef.current}/2`,
          lastErrorClass: lastErrorClassRef.current,
          playbackStartState: playbackStartStateRef.current,
          autoplayBlocked: autoplayBlockedRef.current,
          playIntentActive: playIntentRef.current,
          operationOwner: operationOwnerRef.current,
          reinitLocked: reinitLockRef.current,
          pendingReinitReason: pendingReinitRequestedRef.current
            ? pendingReinitReasonRef.current
            : null,
          requiresPriming,
          isPrimed: playPrimedRef.current,
          startupAttemptId: startupAttemptIdRef.current,
          gestureTapCount: gestureTapCountRef.current,
          lastGestureAtMs: lastGestureAtMsRef.current,
          lastPlayAttempt: lastPlayAttemptRef.current,
          startupCalledFromGesture: startupCalledFromGestureRef.current,
          ...patch,
        };

        if (typeof window !== "undefined" && shouldExposeHlsE2EProbe) {
          window.__HLS_E2E_PROBE__ = {
            playbackEngine,
            manifestParsed,
            nativeMetadataLoaded,
            readinessStage: nextDebugState.readinessStage ?? "INIT",
            readyState: nextDebugState.readyState ?? 0,
            buffering: Boolean(nextDebugState.buffering),
            recoveryState: nextDebugState.recoveryState ?? "IDLE",
            playbackStartState: nextDebugState.playbackStartState ?? "IDLE",
            autoplayBlocked: Boolean(nextDebugState.autoplayBlocked),
            playIntentActive: Boolean(nextDebugState.playIntentActive),
            operationOwner: nextDebugState.operationOwner ?? "none",
            reinitLocked: Boolean(nextDebugState.reinitLocked),
            pendingReinitReason: nextDebugState.pendingReinitReason ?? null,
            requiresPriming: Boolean(nextDebugState.requiresPriming),
            isPrimed: Boolean(nextDebugState.isPrimed),
            startupAttemptId: nextDebugState.startupAttemptId ?? 0,
            gestureTapCount: nextDebugState.gestureTapCount ?? 0,
            lastGestureAtMs: nextDebugState.lastGestureAtMs ?? null,
            lastPlayAttempt:
              (nextDebugState.lastPlayAttempt as LastPlayAttempt | null) ?? null,
            startupCalledFromGesture: Boolean(
              nextDebugState.startupCalledFromGesture,
            ),
          };
        }

        const nextSignature = JSON.stringify(nextDebugState);
        if (nextSignature === lastDebugSignatureRef.current) {
          return;
        }
        lastDebugSignatureRef.current = nextSignature;
        onDebugStateChangeCurrent(nextDebugState);
      },
      [requiresPriming],
    );

    const setStatusIfChanged = useCallback((nextStatus: string) => {
      setStatusText((current) => (current === nextStatus ? current : nextStatus));
    }, []);

    const resolveOwnedStatusText = useCallback(
      (
        state: PlaybackStartState,
        owner: OperationOwner,
        currentPhase: PremierePhase,
      ): string => {
        if (
          state === "PRIMING_REQUIRED" ||
          state === "BLOCKED_AUTOPLAY" ||
          state === "DEGRADED"
        ) {
          return statusTextForPlaybackStartState(state);
        }

        if (currentPhase === "SILENCE") {
          return "Silence interval in progress.";
        }

        if (owner === "token_refresh") {
          return "Refreshing stream token...";
        }
        if (owner === "recovery") {
          return "Reconnecting stream...";
        }
        if (owner === "startup") {
          return statusTextForPlaybackStartState("STARTING");
        }
        return statusTextForPlaybackStartState(state);
      },
      [],
    );

    const setStatusForOwner = useCallback(
      (owner: OperationOwner) => {
        setStatusIfChanged(
          resolveOwnedStatusText(
            playbackStartStateRef.current,
            owner,
            phaseRef.current,
          ),
        );
      },
      [resolveOwnedStatusText, setStatusIfChanged],
    );

    const updateRecoveryState = useCallback((next: HlsRecoveryState) => {
      recoveryStateRef.current = next;
      setRecoveryState(next);
    }, []);

    const updatePlaybackStartState = useCallback(
      (next: PlaybackStartState, options?: { keepStatus?: boolean }) => {
        playbackStartStateRef.current = next;
        setPlaybackStartState(next);
        if (!options?.keepStatus) {
          setStatusIfChanged(
            resolveOwnedStatusText(next, operationOwnerRef.current, phaseRef.current),
          );
        }
      },
      [resolveOwnedStatusText, setStatusIfChanged],
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

    const clearGestureOverlayTimers = useCallback(() => {
      if (gestureOverlayAcceptTimerRef.current) {
        window.clearTimeout(gestureOverlayAcceptTimerRef.current);
        gestureOverlayAcceptTimerRef.current = null;
      }
      if (gestureOverlayExitTimerRef.current) {
        window.clearTimeout(gestureOverlayExitTimerRef.current);
        gestureOverlayExitTimerRef.current = null;
      }
    }, []);

    const hideGestureOverlayImmediately = useCallback(() => {
      clearGestureOverlayTimers();
      setIsGestureOverlayMounted(false);
      setGestureOverlayPhase("idle");
    }, [clearGestureOverlayTimers]);

    const beginGestureOverlayDismissal = useCallback(() => {
      clearGestureOverlayTimers();
      setIsGestureOverlayMounted(true);
      setGestureOverlayPhase("accepting");
      gestureOverlayAcceptTimerRef.current = window.setTimeout(() => {
        setGestureOverlayPhase("exiting");
        gestureOverlayExitTimerRef.current = window.setTimeout(() => {
          setIsGestureOverlayMounted(false);
          setGestureOverlayPhase("idle");
          gestureOverlayExitTimerRef.current = null;
        }, GESTURE_OVERLAY_EXIT_MS);
        gestureOverlayAcceptTimerRef.current = null;
      }, GESTURE_OVERLAY_ACCEPT_MS);
    }, [clearGestureOverlayTimers]);

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

    const isRefreshEligibleForLivePlayback = useCallback(() => {
      return (
        phaseRef.current === "LIVE" &&
        playbackStartStateRef.current === "PLAYING" &&
        isPlayerReadyRef.current &&
        playIntentRef.current
      );
    }, []);

    const markPendingReinit = useCallback((reason: "token_refresh" | "recovery") => {
      pendingReinitRequestedRef.current = true;
      if (!pendingReinitRequestedAtRef.current) {
        pendingReinitRequestedAtRef.current = Date.now();
      }
      if (
        pendingReinitReasonRef.current === null ||
        reason === "recovery"
      ) {
        pendingReinitReasonRef.current = reason;
      }
    }, []);

    const clearPendingReinit = useCallback(() => {
      pendingReinitRequestedRef.current = false;
      pendingReinitReasonRef.current = null;
      pendingReinitRequestedAtRef.current = null;
    }, []);

    const runSerializedReinit = useCallback(
      async (
        owner: "token_refresh" | "recovery",
        operation: () => Promise<void>,
      ): Promise<boolean> => {
        if (reinitLockRef.current) {
          markPendingReinit(owner);
          publishDebugState();
          return false;
        }

        reinitLockRef.current = true;
        operationOwnerRef.current = owner;
        invalidateStartupAttempt();
        setStatusForOwner(owner);
        publishDebugState({
          operationOwner: owner,
          reinitLocked: true,
        });

        try {
          await operation();
          return true;
        } finally {
          reinitLockRef.current = false;
          operationOwnerRef.current = "none";
          publishDebugState({
            operationOwner: "none",
            reinitLocked: false,
          });

          const schedule =
            typeof queueMicrotask === "function"
              ? queueMicrotask
              : (cb: () => void) => {
                  window.setTimeout(cb, 0);
                };

          schedule(() => {
            drainPendingReinitRef.current();
          });
        }
      },
      [
        invalidateStartupAttempt,
        markPendingReinit,
        publishDebugState,
        setStatusForOwner,
      ],
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
        publishDebugState({
          isPrimed: value,
        });
      },
      [publishDebugState, room],
    );

    const markGestureTap = useCallback(() => {
      gestureTapCountRef.current += 1;
      lastGestureAtMsRef.current = Date.now();
      publishDebugState({
        gestureTapCount: gestureTapCountRef.current,
        lastGestureAtMs: lastGestureAtMsRef.current,
      });
    }, [publishDebugState]);

    const updateLastPlayAttempt = useCallback(
      (next: LastPlayAttempt) => {
        const current = lastPlayAttemptRef.current;
        const currentRank = getPlayAttemptRank(current);
        const nextRank = getPlayAttemptRank(next);
        if (nextRank < currentRank) {
          return;
        }
        if (currentRank === 2) {
          return;
        }
        if (current === next) {
          return;
        }
        lastPlayAttemptRef.current = next;
        publishDebugState({
          lastPlayAttempt: next,
        });
      },
      [publishDebugState],
    );

    const markStartupCalledFromGesture = useCallback(() => {
      if (startupCalledFromGestureRef.current) {
        return;
      }
      startupCalledFromGestureRef.current = true;
      publishDebugState({
        startupCalledFromGesture: true,
      });
    }, [publishDebugState]);

    const resetGestureProbeState = useCallback(() => {
      gestureTapCountRef.current = 0;
      lastGestureAtMsRef.current = null;
      lastPlayAttemptRef.current = null;
      startupCalledFromGestureRef.current = false;
      publishDebugState({
        gestureTapCount: 0,
        lastGestureAtMs: null,
        lastPlayAttempt: null,
        startupCalledFromGesture: false,
      });
    }, [publishDebugState]);

    const markGesturePlayFailure = useCallback(
      (error: unknown) => {
        updateLastPlayAttempt(toFailedPlayAttempt(error));
      },
      [updateLastPlayAttempt],
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
      async (
        options?: {
          forceHardSeek?: boolean;
          skipOnDemandRefresh?: boolean;
          fromGesture?: boolean;
        },
      ) => {
        const adapter = adapterRef.current;
        const activeScreening = screeningRef.current;
        const video = videoRef.current;
        if (!adapter || !activeScreening || !video) {
          return;
        }

        const ownsStartupStatus = operationOwnerRef.current === "none";
        if (ownsStartupStatus) {
          operationOwnerRef.current = "startup";
          setStatusForOwner("startup");
          publishDebugState({
            operationOwner: "startup",
          });
        }

        let attemptId = 0;
        try {
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

          const startupNow = Date.now();
          const startupAuthRecentlyFailed =
            lastAuthErrorAtMsRef.current > 0 &&
            startupNow - lastAuthErrorAtMsRef.current <= AUTH_RECENT_WINDOW_MS;
          const startupTokenExpiry = tokenExpiresAtRef.current;
          const startupMsUntilExpiry =
            startupTokenExpiry === null
              ? Number.POSITIVE_INFINITY
              : startupTokenExpiry - (startupNow + serverOffsetRef.current);
          const shouldRunStartupRefresh =
            startupAuthRecentlyFailed ||
            startupMsUntilExpiry <= STARTUP_ON_DEMAND_REFRESH_THRESHOLD_MS;
          const startupFromGesture = Boolean(
            options?.fromGesture || gestureTapInFlightRef.current,
          );
          const startupTokenExpired = startupMsUntilExpiry <= 0;

          if (
            phaseRef.current === "LIVE" &&
            !options?.skipOnDemandRefresh &&
            shouldRunStartupRefresh
          ) {
            if (startupFromGesture && !startupTokenExpired) {
              markPendingReinit("token_refresh");
              publishDebugState();
            } else {
              const didRefresh = await runSerializedReinit("token_refresh", async () => {
                updateRecoveryState("RECOVERING");
                const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
                const refreshedUrl =
                  refreshed?.finalManifestUrl ?? finalManifestUrlRef.current;
                if (refreshed?.tokenExpiresAtUnixMs) {
                  tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
                }
                if (!refreshedUrl) {
                  throw new Error("Missing refreshed manifest URL.");
                }
                await reinitializeWithUrlRef.current(refreshedUrl, {
                  readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
                });
              });
              if (!didRefresh) {
                return;
              }
              updateRecoveryState("IDLE");
              return;
            }
          }

          attemptId = beginStartupAttempt();
          updatePlaybackStartState("STARTING");

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

          if (!video.muted) {
            video.muted = true;
            setIsMuted(true);
          }

          await adapter.play();

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
          if (attemptId !== 0 && !isStartupAttemptActive(attemptId)) {
            return;
          }

          if (isAutoplayBlockedError(error)) {
            playIntentRef.current = false;
            setAutoplayBlockedState(true);
            updatePlaybackStartState(
              requiresPriming ? "PRIMING_REQUIRED" : "BLOCKED_AUTOPLAY",
            );
            stopDriftLoop();
            publishDebugState({
              playbackStartState: requiresPriming
                ? "PRIMING_REQUIRED"
                : "BLOCKED_AUTOPLAY",
              autoplayBlocked: true,
              playIntentActive: false,
            });
            return;
          }

          if (isAuthSuspectedError(error)) {
            lastAuthErrorAtMsRef.current = Date.now();
          }

          throw error;
        } finally {
          if (ownsStartupStatus && operationOwnerRef.current === "startup") {
            operationOwnerRef.current = "none";
            publishDebugState({
              operationOwner: "none",
            });
          }
        }
      },
      [
        beginStartupAttempt,
        clearShortProgressCheck,
        computeTargetTimeSec,
        isStartupAttemptActive,
        publishDebugState,
        requiresPriming,
        markPendingReinit,
        runSerializedReinit,
        scheduleShortProgressCheck,
        setAutoplayBlockedState,
        setStatusForOwner,
        stopDriftLoop,
        syncToCanonicalTime,
        updatePlaybackStartState,
        updateRecoveryState,
        waitForSeekSettled,
      ],
    );

    const reinitializeWithUrl = useCallback(
      async (
        nextManifestUrl: string,
        options?: {
          readyTimeoutMs?: number;
        },
      ) => {
        const adapter = adapterRef.current;
        const videoElement = videoRef.current;
        if (!adapter || !videoElement) {
          throw new Error("Playback adapter is unavailable.");
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
            skipOnDemandRefresh: true,
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
        startPlaybackFromCanonical,
        stopDriftLoop,
        syncToCanonicalTime,
      ],
    );

    const runPreemptiveRefresh = useCallback(async (): Promise<void> => {
      if (!isRefreshEligibleForLivePlayback()) {
        markPendingReinit("token_refresh");
        publishDebugState();
        return;
      }
      if (recoveryStateRef.current === "DEGRADED") {
        clearPendingReinit();
        publishDebugState();
        return;
      }
      if (reinitLockRef.current || gestureTapInFlightRef.current) {
        markPendingReinit("token_refresh");
        publishDebugState();
        return;
      }

      const now = Date.now();
      if (now - lastTokenRefreshAtRef.current < TOKEN_REFRESH_COOLDOWN_MS) {
        return;
      }
      lastTokenRefreshAtRef.current = now;

      try {
        const didRun = await runSerializedReinit("token_refresh", async () => {
          updateRecoveryState("RECOVERING");
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
            readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
          });
        });

        if (!didRun) {
          return;
        }

        updateRecoveryState("IDLE");
        setStatusIfChanged("Live playback synchronized.");
      } catch (error) {
        if (isAuthSuspectedError(error)) {
          lastAuthErrorAtMsRef.current = Date.now();
        }
        console.error(error);
        void attemptRecoveryRef.current("AUTH_SUSPECTED");
      }
    }, [
      clearPendingReinit,
      isRefreshEligibleForLivePlayback,
      markPendingReinit,
      publishDebugState,
      reinitializeWithUrl,
      runSerializedReinit,
      setStatusIfChanged,
      updateRecoveryState,
    ]);

    const drainPendingReinit = useCallback(() => {
      if (!pendingReinitRequestedRef.current) {
        return;
      }

      const pendingReason = pendingReinitReasonRef.current;
      if (!pendingReason) {
        clearPendingReinit();
        publishDebugState();
        return;
      }

      if (pendingReason === "token_refresh") {
        const isEligible = isRefreshEligibleForLivePlayback();
        if (!isEligible) {
          clearPendingReinit();
          publishDebugState();
          return;
        }

        const pendingAgeMs = pendingReinitRequestedAtRef.current
          ? Date.now() - pendingReinitRequestedAtRef.current
          : 0;
        if (pendingAgeMs > PENDING_REFRESH_MAX_AGE_MS) {
          clearPendingReinit();
          publishDebugState();
          return;
        }

        if (
          reinitLockRef.current ||
          recoveryInFlightRef.current ||
          gestureTapInFlightRef.current
        ) {
          return;
        }

        clearPendingReinit();
        publishDebugState();
        void runPreemptiveRefreshRef.current();
        return;
      }

      if (recoveryStateRef.current === "DEGRADED") {
        clearPendingReinit();
        publishDebugState();
        return;
      }

      if (reinitLockRef.current || recoveryInFlightRef.current) {
        return;
      }

      clearPendingReinit();
      publishDebugState();
      void attemptRecoveryRef.current(lastErrorClassRef.current ?? "NETWORK_OR_PARSE");
    }, [
      clearPendingReinit,
      isRefreshEligibleForLivePlayback,
      publishDebugState,
    ]);

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
        const didRun = await runSerializedReinit("recovery", async () => {
          await reinitializeWithUrl(currentUrl, {
            readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
          });
        });
        if (!didRun) {
          return true;
        }
        return true;
      }

      if (networkRecoveryStepRef.current === 1) {
        networkRecoveryStepRef.current = 2;
        const didRun = await runSerializedReinit("recovery", async () => {
          const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
          const refreshedUrl = refreshed?.finalManifestUrl ?? currentUrl;
          if (refreshed?.tokenExpiresAtUnixMs) {
            tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
          }
          if (!refreshedUrl) {
            throw new Error("Missing refreshed manifest URL.");
          }
          await reinitializeWithUrl(refreshedUrl, {
            readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
          });
        });
        if (!didRun) {
          return true;
        }
        return true;
      }

      enterDegradedState(
        "NETWORK_OR_PARSE",
        "Playback issue - Retry to reconnect stream.",
      );
      return false;
    }, [enterDegradedState, reinitializeWithUrl, runSerializedReinit]);

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

            const didRun = await runSerializedReinit("recovery", async () => {
              const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
              const nextUrl =
                refreshed?.finalManifestUrl ?? finalManifestUrlRef.current;
              if (refreshed?.tokenExpiresAtUnixMs) {
                tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
              }
              if (!nextUrl) {
                throw new Error("Missing refreshed manifest URL.");
              }

              await reinitializeWithUrl(nextUrl, {
                readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
              });
            });
            if (!didRun) {
              return;
            }
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
          if (isAuthSuspectedError(error)) {
            lastAuthErrorAtMsRef.current = Date.now();
          }
          console.error(error);
          const nextClass =
            errorClass === "AUTH_SUSPECTED" || isAuthSuspectedError(error)
              ? "AUTH_SUSPECTED"
              : "NETWORK_OR_PARSE";
          updateLastErrorClass(nextClass);
          const recovered = await recoverNetworkOrParse();
          if (recovered) {
            updateRecoveryState("IDLE");
            setStatusIfChanged("Stream recovered.");
          }
        } finally {
          recoveryInFlightRef.current = false;
          publishDebugState();
          drainPendingReinitRef.current();
        }
      },
      [
        enterDegradedState,
        publishDebugState,
        recoverNetworkOrParse,
        reinitializeWithUrl,
        runSerializedReinit,
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

        const errorClass = classifyFatalError(error);
        if (errorClass === "AUTH_SUSPECTED") {
          lastAuthErrorAtMsRef.current = Date.now();
        }
        await attemptRecovery(errorClass);
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
    reinitializeWithUrlRef.current = reinitializeWithUrl;
    recoverFromPlaybackFailureRef.current = recoverFromPlaybackFailure;
    attemptRecoveryRef.current = attemptRecovery;
    runPreemptiveRefreshRef.current = runPreemptiveRefresh;
    drainPendingReinitRef.current = drainPendingReinit;
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
      if (!pendingReinitRequestedRef.current) {
        return;
      }

      if (pendingReinitReasonRef.current === "token_refresh") {
        const isRefreshEligible =
          phase === "LIVE" &&
          playbackStartState === "PLAYING" &&
          isPlayerReady &&
          playIntentRef.current;

        if (!isRefreshEligible) {
          clearPendingReinit();
          publishDebugState();
          return;
        }

        const pendingAgeMs = pendingReinitRequestedAtRef.current
          ? Date.now() - pendingReinitRequestedAtRef.current
          : 0;
        if (pendingAgeMs > PENDING_REFRESH_MAX_AGE_MS) {
          clearPendingReinit();
          publishDebugState();
          return;
        }
      }

      drainPendingReinit();
    }, [
      clearPendingReinit,
      drainPendingReinit,
      isPlayerReady,
      phase,
      playbackStartState,
      publishDebugState,
    ]);

    useEffect(() => {
      const primed = window.sessionStorage.getItem(getPrimingKey(room)) === "1";
      playPrimedRef.current = primed;
      setIsPrimed(primed);
      setAutoplayBlockedState(false);
      resetGestureProbeState();
      updatePlaybackStartState("IDLE", {
        keepStatus: true,
      });
      invalidateStartupAttempt();
    }, [
      invalidateStartupAttempt,
      room,
      resetGestureProbeState,
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
            const unsupportedPlayback = /not supported on this browser/i.test(
              message,
            );
            const errorClass: HlsRecoveryErrorClass =
              message.includes("403") || message.includes("401")
                ? "AUTH_SUSPECTED"
                : "NETWORK_OR_PARSE";
            if (errorClass === "AUTH_SUSPECTED") {
              lastAuthErrorAtMsRef.current = Date.now();
            }
            updateLastErrorClass(errorClass);
            if (unsupportedPlayback) {
              updateRecoveryState("DEGRADED");
              updatePlaybackStartState("DEGRADED");
              setStatusIfChanged("HLS playback is not supported on this browser.");
              publishDebugState();
              return;
            }
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
      publishDebugState,
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
        !playIntentRef.current ||
        playbackStartState !== "PLAYING"
      ) {
        return;
      }

      const timer = window.setInterval(() => {
        if (
          recoveryInFlightRef.current ||
          reinitLockRef.current ||
          gestureTapInFlightRef.current
        ) {
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

        void runPreemptiveRefresh();
      }, 15_000);

      return () => window.clearInterval(timer);
    }, [
      hasAccess,
      isPlayerReady,
      phase,
      playbackStartState,
      recoveryState,
      runPreemptiveRefresh,
    ]);

    const handleOverlayPlaybackTap = useCallback(() => {
      const video = videoRef.current;
      const adapter = adapterRef.current;
      if (!video || !adapter) {
        setStatusText("Player is not ready for playback.");
        return;
      }
      if (gestureTapInFlightRef.current) {
        return;
      }
      gestureTapInFlightRef.current = true;
      markGestureTap();
      updateLastPlayAttempt("attempted");

      video.muted = true;
      setIsMuted(true);

      void (async () => {
        try {
          try {
            await video.play();
            updateLastPlayAttempt("video_play_ok");
          } catch (error) {
            markGesturePlayFailure(error);
            throw error;
          }

          setPrimed(true);

          if (phaseRef.current === "WAITING") {
            playIntentRef.current = false;
            bufferingRef.current = false;
            setBuffering(false);
            clearShortProgressCheck();
            updatePlaybackStartState("IDLE", {
              keepStatus: true,
            });
            setStatusIfChanged("Playback primed. Waiting for start.");
            window.requestAnimationFrame(() => {
              void video.pause();
            });
            beginGestureOverlayDismissal();
            return;
          }

          beginGestureOverlayDismissal();
          markStartupCalledFromGesture();
          await startPlaybackFromCanonical({
            forceHardSeek: true,
            fromGesture: true,
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
          if (isAuthSuspectedError(error)) {
            lastAuthErrorAtMsRef.current = Date.now();
          }
          setStatusIfChanged("Playback start failed. Tap again.");
        } finally {
          gestureTapInFlightRef.current = false;
        }
      })();
    }, [
      beginGestureOverlayDismissal,
      clearShortProgressCheck,
      markGesturePlayFailure,
      markGestureTap,
      requiresPriming,
      setAutoplayBlockedState,
      setPrimed,
      setStatusIfChanged,
      startPlaybackFromCanonical,
      stopDriftLoop,
      markStartupCalledFromGesture,
      updateLastPlayAttempt,
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
      clearPendingReinit();

      try {
        const didRun = await runSerializedReinit("recovery", async () => {
          const refreshed = (await onBootstrapRefreshRef.current?.()) ?? null;
          const nextUrl =
            refreshed?.finalManifestUrl ?? finalManifestUrlRef.current;
          if (refreshed?.tokenExpiresAtUnixMs) {
            tokenExpiresAtRef.current = refreshed.tokenExpiresAtUnixMs;
          }
          if (!nextUrl) {
            throw new Error("Missing refreshed manifest URL.");
          }

          await reinitializeWithUrl(nextUrl, {
            readyTimeoutMs: RECOVERY_READY_TIMEOUT_MS,
          });
        });
        if (!didRun) {
          return;
        }
        setStatusIfChanged("Stream recovered.");
        updateRecoveryState("IDLE");
      } catch (error) {
        if (isAuthSuspectedError(error)) {
          lastAuthErrorAtMsRef.current = Date.now();
        }
        console.error(error);
        enterDegradedState(
          "NETWORK_OR_PARSE",
          "Playback issue - Retry to reconnect stream.",
        );
      }
    }, [
      clearShortProgressCheck,
      clearPendingReinit,
      enterDegradedState,
      reinitializeWithUrl,
      runSerializedReinit,
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
    const isPrimingNeeded = requiresPriming && !isPrimed;
    const isGestureRequired =
      showPlayer &&
      phase !== "SILENCE" &&
      (playbackStartState === "BLOCKED_AUTOPLAY" ||
        (isPrimingNeeded && (phase === "WAITING" || phase === "LIVE")));
    const scrubEnabled =
      rehearsalScrubEnabled && phase !== "LIVE" && phase !== "SILENCE" && showPlayer;
    const showSilenceBlackout = showPlayer && phase === "SILENCE";
    const showRecoveryOverlay =
      showPlayer && !showSilenceBlackout && recoveryState === "DEGRADED";
    const showGestureOverlay =
      showPlayer &&
      !showSilenceBlackout &&
      !showRecoveryOverlay &&
      (isGestureRequired || isGestureOverlayMounted);
    const showWaitingLobbyOverlay =
      showPlayer &&
      !showSilenceBlackout &&
      !showRecoveryOverlay &&
      phase === "WAITING" &&
      !isGestureRequired;

    useEffect(() => {
      if (!showPlayer || recoveryState === "DEGRADED") {
        return;
      }
      if (phase !== "WAITING" && phase !== "LIVE") {
        return;
      }
      if (!requiresPriming || playPrimedRef.current) {
        return;
      }
      if (playbackStartState !== "IDLE") {
        return;
      }
      if (operationOwnerRef.current !== "none") {
        return;
      }
      if (reinitLockRef.current || gestureTapInFlightRef.current) {
        return;
      }
      if (playIntentRef.current) {
        return;
      }
      updatePlaybackStartState("PRIMING_REQUIRED");
    }, [
      phase,
      playbackStartState,
      recoveryState,
      requiresPriming,
      showPlayer,
      updatePlaybackStartState,
    ]);

    useEffect(() => {
      if (showSilenceBlackout || !showPlayer) {
        hideGestureOverlayImmediately();
        return;
      }

      if (isGestureRequired) {
        clearGestureOverlayTimers();
        setIsGestureOverlayMounted(true);
        setGestureOverlayPhase("idle");
        return;
      }

      if (gestureOverlayPhase === "accepting" || gestureOverlayPhase === "exiting") {
        return;
      }

      hideGestureOverlayImmediately();
    }, [
      clearGestureOverlayTimers,
      gestureOverlayPhase,
      hideGestureOverlayImmediately,
      isGestureRequired,
      showPlayer,
      showSilenceBlackout,
    ]);

    useEffect(() => {
      return () => {
        if (typeof window !== "undefined") {
          delete window.__HLS_E2E_PROBE__;
        }
        clearGestureOverlayTimers();
      };
    }, [clearGestureOverlayTimers]);

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
              data-testid="hls-video"
              className="hls-video-element"
              playsInline
              preload="auto"
            />
            {showSilenceBlackout ? (
              <div className="video-blackout">
                <p>Silence</p>
              </div>
            ) : null}
            {showGestureOverlay ? (
              <div
                className={`video-gesture-overlay ${
                  gestureOverlayPhase !== "idle"
                    ? `is-${gestureOverlayPhase}`
                    : ""
                }`.trim()}
              >
                <button
                  type="button"
                  data-testid="gesture-play-cta"
                  className="video-gesture-cta"
                  onClick={handleOverlayPlaybackTap}
                  aria-label="Play"
                  title="Play"
                >
                  <span className="video-gesture-rings" aria-hidden>
                    <span className="video-gesture-ring" />
                    <span className="video-gesture-ring" />
                    <span className="video-gesture-ring" />
                  </span>
                  <svg
                    className="video-gesture-icon"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="M7 5.2L15 10L7 14.8V5.2Z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            ) : null}
            {showWaitingLobbyOverlay ? (
              <div className="video-waiting-lobby">
                <p className="video-waiting-title">Waiting...</p>
                <p className="video-waiting-copy">Starts soon</p>
              </div>
            ) : null}
            {showRecoveryOverlay ? (
              <div className="video-recovery-overlay">
                <p>Playback issue - Retry</p>
                <button
                  type="button"
                  data-testid="recovery-retry"
                  onClick={() => void handleManualRecoveryRetry()}
                >
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
