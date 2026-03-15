import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFixedDurations,
  buildSegmentWindows,
  buildSubtitlePlaylist,
  parseMediaPlaylistDurations,
  parseWebVtt,
  segmentWebVtt,
} from "@/lib/subtitles/hlsVtt";

test("parseMediaPlaylistDurations extracts EXTINF values in order", () => {
  const durations = parseMediaPlaylistDurations(`
#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:5.005,
seg_00000.ts
#EXTINF:4.995,
seg_00001.ts
#EXT-X-ENDLIST
`);

  assert.deepEqual(durations, [5.005, 4.995]);
});

test("segmentWebVtt clips cues to segment windows and rewrites cue times locally", () => {
  const cues = parseWebVtt(`WEBVTT

00:00:04.500 --> 00:00:06.500
hello

00:00:07.000 --> 00:00:09.000
world
`);

  const windows = buildSegmentWindows([5, 5], "sub_", 1.5);
  const segments = segmentWebVtt(cues, windows);

  assert.equal(segments.length, 2);
  assert.match(segments[0].text, /00:00:04\.500 --> 00:00:05\.000/);
  assert.match(segments[1].text, /00:00:00\.000 --> 00:00:01\.500/);
  assert.match(segments[1].text, /00:00:02\.000 --> 00:00:04\.000/);
  assert.match(
    segments[1].text,
    /X-TIMESTAMP-MAP=LOCAL:00:00:00\.000,MPEGTS:585000/,
  );
});

test("buildSubtitlePlaylist emits a VOD playlist with matching segment durations", () => {
  const windows = buildSegmentWindows(buildFixedDurations(12, 5));
  const playlist = buildSubtitlePlaylist(windows);

  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist, /#EXTINF:5\.000,\nsub_00000\.vtt/);
  assert.match(playlist, /#EXTINF:2\.000,\nsub_00002\.vtt/);
  assert.match(playlist, /#EXT-X-ENDLIST/);
});
