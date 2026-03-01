export interface PlaybackAdapter {
  initialize(): Promise<void>;
  waitUntilReady(timeoutMs: number): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seekTo(seconds: number): Promise<void>;
  setPlaybackRate(rate: number): Promise<void>;
  getCurrentTime(): Promise<number>;
  destroy(): Promise<void>;
}
