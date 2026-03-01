"use client";

import Player from "@vimeo/player";
import type { PlaybackAdapter } from "@/lib/playback/types";

const DEFAULT_READY_TIMEOUT_MS = 5_000;

export class VimeoPlaybackAdapter implements PlaybackAdapter {
  private readonly hostElement: HTMLElement;

  private readonly videoId: string;

  private player: Player | null = null;

  constructor(hostElement: HTMLElement, videoId: string) {
    this.hostElement = hostElement;
    this.videoId = videoId;
  }

  async initialize(): Promise<void> {
    if (this.player) {
      return;
    }

    this.player = new Player(this.hostElement, {
      id: Number(this.videoId) || this.videoId,
      byline: false,
      title: false,
      portrait: false,
      controls: false,
      autoplay: false,
      muted: false,
      dnt: true,
    });

    await this.waitUntilReady(DEFAULT_READY_TIMEOUT_MS);
  }

  async waitUntilReady(timeoutMs: number): Promise<void> {
    if (!this.player) {
      throw new Error("Vimeo player is not initialized.");
    }

    await Promise.race([
      this.player.ready(),
      new Promise((_, reject) => {
        const timer = window.setTimeout(() => {
          reject(new Error("Vimeo player readiness timed out."));
        }, timeoutMs);
        void this.player?.ready().finally(() => window.clearTimeout(timer));
      }),
    ]);
  }

  async play(): Promise<void> {
    if (!this.player) {
      return;
    }
    await this.player.play();
  }

  async pause(): Promise<void> {
    if (!this.player) {
      return;
    }
    await this.player.pause();
  }

  async seekTo(seconds: number): Promise<void> {
    if (!this.player) {
      return;
    }
    await this.player.setCurrentTime(seconds);
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.player) {
      return;
    }
    await this.player.setPlaybackRate(rate);
  }

  async getCurrentTime(): Promise<number> {
    if (!this.player) {
      return 0;
    }
    return this.player.getCurrentTime();
  }

  async destroy(): Promise<void> {
    if (!this.player) {
      return;
    }

    await this.player.destroy();
    this.player = null;
  }
}
