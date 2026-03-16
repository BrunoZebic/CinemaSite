import assert from "node:assert/strict";
import test from "node:test";
import { HlsPlaybackAdapter } from "../../../lib/video/hlsAdapterCore";
import {
  FAKE_HLS_EVENTS,
  FakeVideoElement,
  createFakeHlsRuntime,
} from "./support/hlsAdapterFakes";

function trackPromise<T>(promise: Promise<T>): {
  tracked: Promise<T>;
  getState: () => "pending" | "resolved" | "rejected";
} {
  let state: "pending" | "resolved" | "rejected" = "pending";
  return {
    tracked: promise.then(
      (value) => {
        state = "resolved";
        return value;
      },
      (error) => {
        state = "rejected";
        throw error;
      },
    ),
    getState: () => state,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

test("native READY waits for metadata and reliable seek conditions", async () => {
  const { runtime } = createFakeHlsRuntime({ supported: false });
  const adapter = new HlsPlaybackAdapter(runtime);
  const video = new FakeVideoElement();
  video.canPlayTypeValue = "probably";

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8",
  );

  assert.equal(adapter.getPlaybackEngine(), "native");
  assert.equal(adapter.getReadinessStage(), "MANIFEST_LOADING");

  const readiness = trackPromise(adapter.waitUntilReady(1_000));
  await flushMicrotasks();
  assert.equal(readiness.getState(), "pending");

  video.emit("loadedmetadata", { readyState: 1, seekableLength: 0 });
  await flushMicrotasks();
  assert.equal(adapter.getReadinessStage(), "METADATA");
  assert.equal(adapter.isReady(), false);
  assert.equal(readiness.getState(), "pending");

  video.emit("canplay", { readyState: 2, seekableLength: 1 });
  await assert.doesNotReject(readiness.tracked);
  assert.equal(adapter.isReady(), true);
  assert.equal(adapter.getReadinessStage(), "READY");
});

test("buffering flags flip on waiting/stalled and clear on canplay/playing", async () => {
  const { runtime } = createFakeHlsRuntime({ supported: false });
  const adapter = new HlsPlaybackAdapter(runtime);
  const video = new FakeVideoElement();
  video.canPlayTypeValue = "probably";

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8",
  );

  video.emit("waiting");
  assert.equal(adapter.isBuffering(), true);

  video.emit("stalled");
  assert.equal(adapter.isBuffering(), true);

  video.emit("canplay", { readyState: 2, seekableLength: 1 });
  assert.equal(adapter.isBuffering(), false);

  video.emit("waiting");
  assert.equal(adapter.isBuffering(), true);

  video.emit("playing", { paused: false });
  assert.equal(adapter.isBuffering(), false);
});

test(
  "waitUntilReady timeout includes the current readiness stage",
  { concurrency: false },
  async (t) => {
    t.mock.timers.enable({
      apis: ["setTimeout"],
    });
    t.after(() => {
      t.mock.timers.reset();
    });

    const { runtime } = createFakeHlsRuntime({ supported: false });
    const adapter = new HlsPlaybackAdapter(runtime);
    const video = new FakeVideoElement();
    video.canPlayTypeValue = "probably";

    await adapter.initialize(
      video as unknown as HTMLVideoElement,
      "https://cdn.example.com/master.m3u8",
    );

    const readiness = adapter.waitUntilReady(500);
    t.mock.timers.tick(500);
    await flushMicrotasks();

    await assert.rejects(
      readiness,
      /HLS player readiness timed out\. Stage: MANIFEST_LOADING\./,
    );
  },
);

test("destroy prevents late video events from mutating adapter state", async () => {
  const { runtime } = createFakeHlsRuntime({ supported: false });
  const adapter = new HlsPlaybackAdapter(runtime);
  const video = new FakeVideoElement();
  video.canPlayTypeValue = "probably";

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8",
  );

  video.emit("waiting");
  assert.equal(adapter.isBuffering(), true);

  await adapter.destroy();
  assert.equal(adapter.getReadinessStage(), "INIT");
  assert.equal(adapter.isBuffering(), false);
  assert.equal(adapter.isReady(), false);
  assert.equal(adapter.getLastFatalError(), null);

  video.emit("canplay", { readyState: 4, seekableLength: 1 });
  video.emit("waiting");
  video.emit("error");
  await flushMicrotasks();

  assert.equal(adapter.getReadinessStage(), "INIT");
  assert.equal(adapter.isBuffering(), false);
  assert.equal(adapter.isReady(), false);
  assert.equal(adapter.getLastFatalError(), null);
});

test("hls.js initialize and destroy ordering stays load-attach then detach-destroy", async () => {
  const controls = createFakeHlsRuntime({ supported: true });
  const adapter = new HlsPlaybackAdapter(controls.runtime);
  const video = new FakeVideoElement();

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8?token=abc",
  );

  assert.equal(controls.instances.length, 1);
  assert.deepEqual(controls.instances[0].callOrder, ["loadSource", "attachMedia"]);

  await adapter.destroy();

  assert.deepEqual(controls.instances[0].callOrder, [
    "loadSource",
    "attachMedia",
    "detachMedia",
    "destroy",
  ]);
});

test("hls.js READY requires media attached, manifest parsed, and seekable metadata", async () => {
  const controls = createFakeHlsRuntime({ supported: true });
  const adapter = new HlsPlaybackAdapter(controls.runtime);
  const video = new FakeVideoElement();

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8?token=abc",
  );

  const hls = controls.instances[0];
  const readiness = trackPromise(adapter.waitUntilReady(1_000));

  hls.emit(FAKE_HLS_EVENTS.MEDIA_ATTACHED);
  await flushMicrotasks();
  assert.equal(readiness.getState(), "pending");
  assert.equal(adapter.getReadinessStage(), "MANIFEST_LOADING");

  video.emit("loadedmetadata", { readyState: 2, seekableLength: 1 });
  await flushMicrotasks();
  assert.equal(readiness.getState(), "pending");
  assert.equal(adapter.getReadinessStage(), "METADATA");

  hls.emit(FAKE_HLS_EVENTS.MANIFEST_PARSED);
  await assert.doesNotReject(readiness.tracked);
  assert.equal(adapter.getReadinessStage(), "READY");
  assert.equal(adapter.isManifestParsed(), true);
  assert.equal(adapter.isReady(), true);
});

test("hls.js error events obey fatal mapping rules", async () => {
  const controls = createFakeHlsRuntime({ supported: true });
  const adapter = new HlsPlaybackAdapter(controls.runtime);
  const video = new FakeVideoElement();
  const fatalErrors: Array<{
    statusCode?: number;
    details?: string;
    isForbidden: boolean;
  }> = [];
  adapter.setFatalListener((error) => {
    fatalErrors.push(error);
  });

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8?token=abc",
  );

  const hls = controls.instances[0];
  hls.emit(FAKE_HLS_EVENTS.ERROR, {
    fatal: false,
    response: { code: 500 },
    details: "fragLoadError",
  });

  assert.equal(fatalErrors.length, 0);
  assert.equal(adapter.getReadinessStage(), "MANIFEST_LOADING");

  hls.emit(FAKE_HLS_EVENTS.ERROR, {
    fatal: true,
    response: { code: 503 },
    details: "manifestLoadError",
  });

  assert.deepEqual(fatalErrors, [
    {
      statusCode: 503,
      details: "manifestLoadError",
      isForbidden: false,
    },
  ]);
  assert.equal(adapter.getReadinessStage(), "ERROR");
});

test("destroy prevents late Hls callbacks from mutating state or notifying listeners", async () => {
  const controls = createFakeHlsRuntime({ supported: true });
  const adapter = new HlsPlaybackAdapter(controls.runtime);
  const video = new FakeVideoElement();
  const fatalErrors: Array<{
    statusCode?: number;
    details?: string;
    isForbidden: boolean;
  }> = [];
  adapter.setFatalListener((error) => {
    fatalErrors.push(error);
  });

  await adapter.initialize(
    video as unknown as HTMLVideoElement,
    "https://cdn.example.com/master.m3u8?token=abc",
  );

  const hls = controls.instances[0];
  await adapter.destroy();

  hls.emit(FAKE_HLS_EVENTS.MEDIA_ATTACHED);
  hls.emit(FAKE_HLS_EVENTS.MANIFEST_PARSED);
  hls.emit(FAKE_HLS_EVENTS.ERROR, {
    fatal: true,
    response: { code: 503 },
    details: "manifestLoadError",
  });
  await flushMicrotasks();

  assert.equal(adapter.getReadinessStage(), "INIT");
  assert.equal(adapter.isReady(), false);
  assert.equal(adapter.isBuffering(), false);
  assert.equal(fatalErrors.length, 0);
});
