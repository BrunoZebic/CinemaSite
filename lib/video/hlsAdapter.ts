"use client";

import Hls, {
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from "hls.js";
import {
  HLS_MIME_TYPE,
  manifestParsedForEngine,
  selectHlsEngine,
  type HlsPlaybackEngine,
} from "@/lib/video/hlsEngineSelection";

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

export type HlsAdapterLifecycleDebug = {
  hlsInstanceId: number;
  attachCount: number;
  detachCount: number;
  srcSetCount: number;
  loadCalledCount: number;
  adapterGenerationId: number;
};

type FatalListener = (error: HlsFatalError) => void;

let nextGlobalHlsInstanceId = 1;

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

  private playbackEngine: HlsPlaybackEngine = "unsupported";

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

  private adapterGenerationId = 0;

  private hlsInstanceId = 0;

  private attachCount = 0;

  private detachCount = 0;

  private srcSetCount = 0;

  private loadCalledCount = 0;

  private attached = false;

  private _subtitleEnabled: boolean = true;

  private _englishTrackIndex: number | null = null;

  private _englishTextTrack: TextTrack | null = null;

  private _hasSubtitleTrack: boolean = false;

  private _subtitleTrackListener: (() => void) | null = null;

  setFatalListener(listener: FatalListener | null): void {
    this.fatalListener = listener;
  }

  setSubtitleTrackListener(cb: (() => void) | null): void {
    this._subtitleTrackListener = cb;
  }

  hasSubtitleTrack(): boolean {
    return this._hasSubtitleTrack;
  }

  setSubtitleEnabled(enabled: boolean): void {
    this._subtitleEnabled = enabled;
    if (this.hls && this._englishTrackIndex !== null) {
      this.hls.subtitleDisplay = enabled;
      if (enabled) {
        this.hls.subtitleTrack = this._englishTrackIndex;
      }
    }
    if (this._englishTextTrack) {
      this._englishTextTrack.mode = enabled ? "showing" : "hidden";
    }
  }

  getSubtitleEnabled(): boolean {
    return this._subtitleEnabled;
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
    return manifestParsedForEngine(this.playbackEngine, this.manifestParsed);
  }

  getPlaybackEngine(): HlsPlaybackEngine {
    return this.playbackEngine;
  }

  isNativeMetadataLoaded(): boolean {
    return this.playbackEngine === "native" && this.metadataLoaded;
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

    if (this.playbackEngine === "hls.js" && !this.isManifestParsed()) {
      return false;
    }

    return video.readyState >= 2 || video.seekable.length > 0;
  }

  getReadyState(): number {
    return this.video?.readyState ?? 0;
  }

  getLifecycleDebug(): HlsAdapterLifecycleDebug {
    return {
      hlsInstanceId: this.hlsInstanceId,
      attachCount: this.attachCount,
      detachCount: this.detachCount,
      srcSetCount: this.srcSetCount,
      loadCalledCount: this.loadCalledCount,
      adapterGenerationId: this.adapterGenerationId,
    };
  }

  private incrementGeneration(): number {
    this.adapterGenerationId += 1;
    return this.adapterGenerationId;
  }

  private isGenerationStale(generation: number): boolean {
    return generation !== this.adapterGenerationId;
  }

  private setVideoSrc(video: HTMLVideoElement, src: string): void {
    video.src = src;
    this.srcSetCount += 1;
  }

  private clearVideoSrc(video: HTMLVideoElement): void {
    video.removeAttribute("src");
    this.srcSetCount += 1;
  }

  private callVideoLoad(video: HTMLVideoElement): void {
    video.load();
    this.loadCalledCount += 1;
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
    generation: number,
    listener: (event: HTMLMediaElementEventMap[K]) => void,
  ): void {
    const guarded = (event: HTMLMediaElementEventMap[K]) => {
      if (this.isGenerationStale(generation)) {
        return;
      }
      listener(event);
    };
    video.addEventListener(eventName, guarded as EventListener);
    this.cleanupFns.push(() =>
      video.removeEventListener(eventName, guarded as EventListener),
    );
  }

  private _tryResolveTrackFromList(tracks: TextTrackList): boolean {
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      if (
        track.language === "en" ||
        track.label?.toLowerCase().includes("english")
      ) {
        this._englishTextTrack = track;
        this._hasSubtitleTrack = true;
        track.mode = this._subtitleEnabled ? "showing" : "hidden";
        this._subtitleTrackListener?.();
        return true;
      }
    }
    return false;
  }

  private _resolveNativeSubtitleTrack(
    video: HTMLVideoElement,
    generation: number,
  ): void {
    const found = this._tryResolveTrackFromList(video.textTracks);
    if (found) return;
    // Safari race: textTracks not yet populated — listen for addtrack
    const onAddTrack = () => {
      if (this.isGenerationStale(generation)) return;
      const resolved = this._tryResolveTrackFromList(video.textTracks);
      if (resolved) {
        cleanup();
      }
    };
    const cleanup = () =>
      video.textTracks.removeEventListener("addtrack", onAddTrack);
    video.textTracks.addEventListener("addtrack", onAddTrack);
    this.cleanupFns.push(cleanup);
  }

  async initialize(video: HTMLVideoElement, manifestUrl: string): Promise<void> {
    // Reset subtitle availability and notify component before destroying prior instance
    this._englishTrackIndex = null;
    this._englishTextTrack = null;
    this._hasSubtitleTrack = false;
    this._subtitleTrackListener?.();
    await this.destroy();
    const generation = this.incrementGeneration();
    this.readinessStage = "ATTACHING";
    this.lastFatalError = null;
    this.video = video;
    this.manifestUrl = manifestUrl;
    this.buffering = false;
    this.nativeHls = false;
    this.playbackEngine = "unsupported";
    this.mediaAttached = false;
    this.metadataLoaded = false;
    this.manifestParsed = false;
    this.pendingSeekSec = null;
    this.attached = false;
    this.createReadyPromise();

    this.addVideoListener(video, "loadedmetadata", generation, () => {
      this.metadataLoaded = true;
      if (this.readinessStage !== "READY") {
        this.readinessStage = "METADATA";
      }
      this.tryMarkReady();
      if (this.nativeHls) {
        this._resolveNativeSubtitleTrack(video, generation);
      }
    });
    this.addVideoListener(video, "canplay", generation, () => {
      this.buffering = false;
      this.metadataLoaded = true;
      if (this.readinessStage !== "READY") {
        this.readinessStage = "METADATA";
      }
      this.tryMarkReady();
    });
    this.addVideoListener(video, "playing", generation, () => {
      this.buffering = false;
    });
    this.addVideoListener(video, "waiting", generation, () => {
      this.buffering = true;
    });
    this.addVideoListener(video, "stalled", generation, () => {
      this.buffering = true;
    });
    this.addVideoListener(video, "error", generation, () => {
      this.emitFatal({
        isForbidden: false,
      });
    });

    const userAgent =
      typeof navigator !== "undefined" && typeof navigator.userAgent === "string"
        ? navigator.userAgent
        : "";
    const hlsJsSupported = Hls.isSupported();
    const nativeCanPlay = video.canPlayType(HLS_MIME_TYPE) !== "";
    const selectedEngine = selectHlsEngine({
      userAgent,
      hlsJsSupported,
      nativeCanPlay,
    });

    this.playbackEngine = selectedEngine;
    this.nativeHls = selectedEngine === "native";

    if (selectedEngine === "native") {
      this.mediaAttached = true;
      this.attached = true;
      this.attachCount += 1;
      this.readinessStage = "MANIFEST_LOADING";
      this.setVideoSrc(video, manifestUrl);
      this.callVideoLoad(video);
      return;
    }

    if (selectedEngine === "unsupported") {
      const unsupportedError = new Error(
        "HLS playback is not supported on this browser.",
      );
      this.emitFatal({
        details: unsupportedError.message,
        isForbidden: false,
      });
      throw unsupportedError;
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
    this.hlsInstanceId = nextGlobalHlsInstanceId;
    nextGlobalHlsInstanceId += 1;

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (this.isGenerationStale(generation)) {
        return;
      }
      this.manifestParsed = true;
      this.readinessStage = "MANIFEST_PARSED";
      this.tryMarkReady();
    });

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (this.isGenerationStale(generation)) {
        return;
      }
      this.mediaAttached = true;
      this.tryMarkReady();
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (this.isGenerationStale(generation)) {
        return;
      }
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

    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
      if (this.isGenerationStale(generation)) {
        return;
      }
      const track = data.subtitleTracks.find(
        (t) => t.lang === "en" || t.name?.toLowerCase().includes("english"),
      );
      if (!track) return;
      this._englishTrackIndex = track.id;
      this._hasSubtitleTrack = true;
      hls.subtitleTrack = track.id;
      hls.subtitleDisplay = this._subtitleEnabled;
      this._subtitleTrackListener?.();
    });

    this.readinessStage = "MANIFEST_LOADING";
    hls.loadSource(manifestUrl);
    hls.attachMedia(video);
    this.attached = true;
    this.attachCount += 1;
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
    this.incrementGeneration();
    for (const cleanup of this.cleanupFns.splice(0)) {
      cleanup();
    }

    if (this.hls) {
      if (this.attached) {
        try {
          this.hls.detachMedia();
        } catch {
          // no-op
        }
        this.detachCount += 1;
        this.attached = false;
      }
      this.hls.destroy();
      this.hls = null;
    }

    if (this.video) {
      if (this.attached) {
        this.detachCount += 1;
        this.attached = false;
      }
      this.clearVideoSrc(this.video);
      this.callVideoLoad(this.video);
    }

    this.video = null;
    this.manifestUrl = null;
    this.readinessStage = "INIT";
    this.lastFatalError = null;
    this.ready = false;
    this.manifestParsed = false;
    this.buffering = false;
    this.nativeHls = false;
    this.playbackEngine = "unsupported";
    this.mediaAttached = false;
    this.metadataLoaded = false;
    this.pendingSeekSec = null;
    this.readyResolver = null;
    this.readyPromise = Promise.resolve();
    this._englishTrackIndex = null;
    this._englishTextTrack = null;
    this._hasSubtitleTrack = false;
    // _subtitleEnabled and _subtitleTrackListener survive destroy — component owns them
  }
}
