"use client";

import Hls, {
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from "hls.js";

export type HlsFatalError = {
  statusCode?: number;
  details?: string;
  isForbidden: boolean;
};

export type HlsReadinessStage =
  | "INIT"
  | "ATTACHING"
  | "MANIFEST_LOADING"
  | "MANIFEST_PARSED"
  | "METADATA"
  | "READY"
  | "ERROR";

type FatalListener = (error: HlsFatalError) => void;

function isFatalForbiddenCode(statusCode: unknown): boolean {
  return statusCode === 401 || statusCode === 403;
}

function normalizeSeekTarget(seconds: number): number {
  if (!Number.isFinite(seconds)) {
    return 0;
  }
  return Math.max(0, seconds);
}

export class HlsPlaybackAdapter {
  private video: HTMLVideoElement | null = null;

  private hls: Hls | null = null;

  private ready = false;

  private manifestParsed = false;

  private buffering = false;

  private nativeHls = false;

  private mediaAttached = false;

  private metadataLoaded = false;

  private pendingSeekSec: number | null = null;

  private readyResolver: (() => void) | null = null;

  private readyPromise: Promise<void> = Promise.resolve();

  private cleanupFns: Array<() => void> = [];

  private fatalListener: FatalListener | null = null;

  private manifestUrl: string | null = null;

  private readinessStage: HlsReadinessStage = "INIT";

  private lastFatalError: HlsFatalError | null = null;

  setFatalListener(listener: FatalListener | null): void {
    this.fatalListener = listener;
  }

  getReadinessStage(): HlsReadinessStage {
    return this.readinessStage;
  }

  getLastFatalError(): HlsFatalError | null {
    return this.lastFatalError;
  }

  isNativeHls(): boolean {
    return this.nativeHls;
  }

  isManifestParsed(): boolean {
    return this.manifestParsed;
  }

  isBuffering(): boolean {
    return this.buffering;
  }

  isReady(): boolean {
    return this.ready;
  }

  canSeekReliably(): boolean {
    const video = this.video;
    if (!video) {
      return false;
    }

    if (!this.mediaAttached || !this.metadataLoaded) {
      return false;
    }

    if (!this.nativeHls && !this.manifestParsed) {
      return false;
    }

    return video.readyState >= 2 || video.seekable.length > 0;
  }

  getReadyState(): number {
    return this.video?.readyState ?? 0;
  }

  private createReadyPromise(): void {
    this.ready = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolver = resolve;
    });
  }

  private markReady(): void {
    if (this.ready) {
      return;
    }
    this.readinessStage = "READY";
    this.ready = true;
    this.readyResolver?.();
    this.readyResolver = null;
    if (this.pendingSeekSec !== null) {
      const queuedSeek = this.pendingSeekSec;
      this.pendingSeekSec = null;
      void this.seekTo(queuedSeek);
    }
  }

  private tryMarkReady(): void {
    if (this.canSeekReliably()) {
      this.markReady();
    }
  }

  private emitFatal(error: HlsFatalError): void {
    this.readinessStage = "ERROR";
    this.lastFatalError = error;
    this.fatalListener?.(error);
  }

  private addVideoListener<K extends keyof HTMLMediaElementEventMap>(
    video: HTMLVideoElement,
    eventName: K,
    listener: (event: HTMLMediaElementEventMap[K]) => void,
  ): void {
    video.addEventListener(eventName, listener as EventListener);
    this.cleanupFns.push(() =>
      video.removeEventListener(eventName, listener as EventListener),
    );
  }

  async initialize(video: HTMLVideoElement, manifestUrl: string): Promise<void> {
    await this.destroy();
    this.readinessStage = "ATTACHING";
    this.lastFatalError = null;
    this.video = video;
    this.manifestUrl = manifestUrl;
    this.buffering = false;
    this.nativeHls = false;
    this.mediaAttached = false;
    this.metadataLoaded = false;
    this.manifestParsed = false;
    this.pendingSeekSec = null;
    this.createReadyPromise();

    this.addVideoListener(video, "loadedmetadata", () => {
      this.metadataLoaded = true;
      if (this.readinessStage !== "READY") {
        this.readinessStage = "METADATA";
      }
      this.tryMarkReady();
    });
    this.addVideoListener(video, "canplay", () => {
      this.buffering = false;
      this.metadataLoaded = true;
      if (this.readinessStage !== "READY") {
        this.readinessStage = "METADATA";
      }
      this.tryMarkReady();
    });
    this.addVideoListener(video, "playing", () => {
      this.buffering = false;
    });
    this.addVideoListener(video, "waiting", () => {
      this.buffering = true;
    });
    this.addVideoListener(video, "stalled", () => {
      this.buffering = true;
    });
    this.addVideoListener(video, "error", () => {
      this.emitFatal({
        isForbidden: false,
      });
    });

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      this.nativeHls = true;
      this.mediaAttached = true;
      this.manifestParsed = true;
      this.readinessStage = "MANIFEST_LOADING";
      video.src = manifestUrl;
      video.load();
      return;
    }

    if (!Hls.isSupported()) {
      throw new Error("HLS playback is not supported on this browser.");
    }

    const manifestOrigin = new URL(manifestUrl).origin;
    const manifestTokenParams = new URL(manifestUrl).searchParams;
    const authParamNames = ["token", "bcdn_token", "expires", "token_path"];
    const authEntries = authParamNames
      .map((name) => [name, manifestTokenParams.get(name)] as const)
      .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));

    function appendAuthParams(rawUrl: string): string {
      if (!authEntries.length) {
        return rawUrl;
      }

      let resolvedUrl: URL;
      try {
        resolvedUrl = new URL(rawUrl, manifestUrl);
      } catch {
        return rawUrl;
      }

      if (resolvedUrl.origin !== manifestOrigin) {
        return resolvedUrl.toString();
      }

      for (const [name, value] of authEntries) {
        if (!resolvedUrl.searchParams.has(name)) {
          resolvedUrl.searchParams.set(name, value);
        }
      }

      return resolvedUrl.toString();
    }

    const BaseLoader = Hls.DefaultConfig.loader;
    class BunnyTokenLoader extends BaseLoader {
      load(
        context: LoaderContext,
        config: LoaderConfiguration,
        callbacks: LoaderCallbacks<LoaderContext>,
      ): void {
        context.url = appendAuthParams(context.url);
        super.load(context, config, callbacks);
      }
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      loader: BunnyTokenLoader,
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.manifestParsed = true;
      this.readinessStage = "MANIFEST_PARSED";
      this.tryMarkReady();
    });

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      this.mediaAttached = true;
      this.tryMarkReady();
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      const statusCode = data.response?.code;
      const forbidden = isFatalForbiddenCode(statusCode);
      if (data.fatal || forbidden) {
        this.emitFatal({
          statusCode: typeof statusCode === "number" ? statusCode : undefined,
          details: data.details,
          isForbidden: forbidden,
        });
      }
    });

    this.readinessStage = "MANIFEST_LOADING";
    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    this.hls = hls;
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        const timer = window.setTimeout(() => {
          const lastError = this.lastFatalError;
          const lastErrorDetails =
            lastError?.statusCode || lastError?.details
              ? ` Last error: ${lastError?.statusCode ?? "n/a"} ${lastError?.details ?? ""}`.trim()
              : "";
          reject(
            new Error(
              `HLS player readiness timed out. Stage: ${this.readinessStage}.${lastErrorDetails ? ` ${lastErrorDetails}` : ""}`,
            ),
          );
        }, timeoutMs);

        void this.readyPromise.finally(() => window.clearTimeout(timer));
      }),
    ]);
  }

  async play(): Promise<void> {
    if (!this.video) {
      return;
    }

    await this.video.play();
  }

  async pause(): Promise<void> {
    if (!this.video) {
      return;
    }

    this.video.pause();
  }

  async seekTo(seconds: number): Promise<void> {
    const target = normalizeSeekTarget(seconds);
    if (!this.video) {
      return;
    }

    if (!this.ready) {
      this.pendingSeekSec = target;
      return;
    }

    try {
      this.video.currentTime = target;
    } catch {
      this.pendingSeekSec = target;
    }
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.video) {
      return;
    }

    this.video.playbackRate = rate;
  }

  async getCurrentTime(): Promise<number> {
    return this.video?.currentTime ?? 0;
  }

  async destroy(): Promise<void> {
    for (const cleanup of this.cleanupFns.splice(0)) {
      cleanup();
    }

    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }

    if (this.video) {
      this.video.removeAttribute("src");
      this.video.load();
    }

    this.video = null;
    this.manifestUrl = null;
    this.readinessStage = "INIT";
    this.lastFatalError = null;
    this.ready = false;
    this.manifestParsed = false;
    this.buffering = false;
    this.nativeHls = false;
    this.mediaAttached = false;
    this.metadataLoaded = false;
    this.pendingSeekSec = null;
    this.readyResolver = null;
    this.readyPromise = Promise.resolve();
  }
}
