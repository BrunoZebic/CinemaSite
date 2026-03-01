"use client";

import Hls from "hls.js";

export type HlsFatalError = {
  statusCode?: number;
  details?: string;
  isForbidden: boolean;
};

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

  private pendingSeekSec: number | null = null;

  private readyResolver: (() => void) | null = null;

  private readyPromise: Promise<void> = Promise.resolve();

  private cleanupFns: Array<() => void> = [];

  private fatalListener: FatalListener | null = null;

  setFatalListener(listener: FatalListener | null): void {
    this.fatalListener = listener;
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
    this.ready = true;
    this.readyResolver?.();
    this.readyResolver = null;
    if (this.pendingSeekSec !== null) {
      const queuedSeek = this.pendingSeekSec;
      this.pendingSeekSec = null;
      void this.seekTo(queuedSeek);
    }
  }

  private emitFatal(error: HlsFatalError): void {
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
    this.video = video;
    this.buffering = false;
    this.nativeHls = false;
    this.manifestParsed = false;
    this.pendingSeekSec = null;
    this.createReadyPromise();

    this.addVideoListener(video, "loadedmetadata", () => {
      this.markReady();
    });
    this.addVideoListener(video, "canplay", () => {
      this.buffering = false;
      this.markReady();
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
      this.manifestParsed = true;
      video.src = manifestUrl;
      video.load();
      return;
    }

    if (!Hls.isSupported()) {
      throw new Error("HLS playback is not supported on this browser.");
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.manifestParsed = true;
      if ((this.video?.readyState ?? 0) >= 1) {
        this.markReady();
      }
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

    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    this.hls = hls;
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error("HLS player readiness timed out."));
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
    this.ready = false;
    this.manifestParsed = false;
    this.buffering = false;
    this.nativeHls = false;
    this.pendingSeekSec = null;
    this.readyResolver = null;
    this.readyPromise = Promise.resolve();
  }
}
