import type {
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
} from "hls.js";
import type {
  HlsInstanceLike,
  HlsLoaderCtor,
  HlsRuntime,
} from "../../../../lib/video/hlsAdapterCore";

export class FakeTextTrackList extends EventTarget {
  private readonly tracks: Array<{
    language?: string;
    label?: string;
    mode: "showing" | "hidden" | "disabled";
  }> = [];

  private indexedLength = 0;

  get length(): number {
    return this.tracks.length;
  }

  pushTrack(track: {
    language?: string;
    label?: string;
    mode: "showing" | "hidden" | "disabled";
  }): void {
    this.tracks.push(track);
    this.syncIndexes();
    this.dispatchEvent(new Event("addtrack"));
  }

  private syncIndexes(): void {
    const target = this as unknown as Record<number, unknown>;
    for (let index = 0; index < this.tracks.length; index += 1) {
      target[index] = this.tracks[index];
    }
    for (let index = this.tracks.length; index < this.indexedLength; index += 1) {
      delete target[index];
    }
    this.indexedLength = this.tracks.length;
  }
}

function createTimeRanges(length: number): TimeRanges {
  return {
    length,
    start() {
      return 0;
    },
    end() {
      return 0;
    },
  } as TimeRanges;
}

export class FakeVideoElement extends EventTarget {
  src = "";

  readyState = 0;

  currentTime = 0;

  playbackRate = 1;

  paused = true;

  canPlayTypeValue = "";

  loadCalls = 0;

  playCalls = 0;

  pauseCalls = 0;

  textTracks = new FakeTextTrackList() as unknown as TextTrackList;

  private seekableLength = 0;

  get seekable(): TimeRanges {
    return createTimeRanges(this.seekableLength);
  }

  setSeekableLength(length: number): void {
    this.seekableLength = length;
  }

  canPlayType(): string {
    return this.canPlayTypeValue;
  }

  load(): void {
    this.loadCalls += 1;
  }

  play(): Promise<void> {
    this.playCalls += 1;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.pauseCalls += 1;
    this.paused = true;
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
    }
  }

  getAttribute(name: string): string | null {
    return name === "src" ? this.src : null;
  }

  emit(
    eventName: string,
    updates?: {
      readyState?: number;
      seekableLength?: number;
      currentTime?: number;
      playbackRate?: number;
      paused?: boolean;
    },
  ): void {
    if (updates?.readyState !== undefined) {
      this.readyState = updates.readyState;
    }
    if (updates?.seekableLength !== undefined) {
      this.seekableLength = updates.seekableLength;
    }
    if (updates?.currentTime !== undefined) {
      this.currentTime = updates.currentTime;
    }
    if (updates?.playbackRate !== undefined) {
      this.playbackRate = updates.playbackRate;
    }
    if (updates?.paused !== undefined) {
      this.paused = updates.paused;
    }

    this.dispatchEvent(new Event(eventName));
  }
}

export class FakeBaseLoader {
  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    void context;
    void config;
    void callbacks;
    // The adapter only needs a constructable base loader for subclassing in tests.
  }
}

export const FAKE_HLS_EVENTS = {
  MANIFEST_PARSED: "MANIFEST_PARSED",
  MEDIA_ATTACHED: "MEDIA_ATTACHED",
  ERROR: "ERROR",
  SUBTITLE_TRACKS_UPDATED: "SUBTITLE_TRACKS_UPDATED",
} as const;

export class FakeHlsInstance implements HlsInstanceLike {
  subtitleTrack = -1;

  subtitleDisplay = false;

  readonly callOrder: string[] = [];

  readonly loadedSources: string[] = [];

  attachedMedia: HTMLVideoElement | null = null;

  detached = false;

  destroyed = false;

  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  loadSource(url: string): void {
    this.callOrder.push("loadSource");
    this.loadedSources.push(url);
  }

  attachMedia(video: HTMLVideoElement): void {
    this.callOrder.push("attachMedia");
    this.attachedMedia = video;
  }

  detachMedia(): void {
    this.callOrder.push("detachMedia");
    this.detached = true;
  }

  destroy(): void {
    this.callOrder.push("destroy");
    this.destroyed = true;
  }

  emit(event: string, data?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(event, data);
    }
  }
}

export type FakeHlsRuntimeControls = {
  runtime: HlsRuntime;
  instances: FakeHlsInstance[];
  createdConfigs: Array<{
    enableWorker: boolean;
    lowLatencyMode: boolean;
    loader: HlsLoaderCtor;
  }>;
};

export function createFakeHlsRuntime(options?: {
  supported?: boolean;
}): FakeHlsRuntimeControls {
  const supported = options?.supported ?? true;
  const instances: FakeHlsInstance[] = [];
  const createdConfigs: Array<{
    enableWorker: boolean;
    lowLatencyMode: boolean;
    loader: HlsLoaderCtor;
  }> = [];

  return {
    runtime: {
      isSupported() {
        return supported;
      },
      Events: FAKE_HLS_EVENTS,
      DefaultConfig: {
        loader: FakeBaseLoader as HlsLoaderCtor,
      },
      create(config) {
        createdConfigs.push(config);
        const instance = new FakeHlsInstance();
        instances.push(instance);
        return instance;
      },
    },
    instances,
    createdConfigs,
  };
}
