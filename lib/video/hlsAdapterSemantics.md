# HLS Adapter Semantics

This document locks the internal contract for `HlsPlaybackAdapter`.

## States
- `READY` means the adapter can seek reliably and `waitUntilReady()` resolves.
- `ERROR` means the adapter observed a fatal playback condition, stored it in `lastFatalError`, and notified the fatal listener.
- `PLAYING` is not an adapter state. It is owned by `HlsSyncPlayer` after the adapter is READY, canonical alignment has run, and playback progression succeeds.

## Readiness
- Native playback reaches READY only after metadata is loaded and the media is seekable (`readyState >= 2` or `seekable.length > 0`).
- `hls.js` playback reaches READY only after media is attached, the manifest is parsed, metadata is loaded, and the media is seekable.
- `waitUntilReady()` timeout errors must include the current readiness stage in the form `Stage: <stage>`.

## Fatal Mapping
- HLS `401` and `403` responses are treated as fatal even when the Hls event payload sets `fatal: false`.
- Non-fatal non-forbidden Hls errors do not mutate adapter fatal state.
- Destroying the adapter resets the readiness stage to `INIT`; late events after destroy must not mutate state.

## Auth Context
- `buildManifestAuthContext()` requires an absolute manifest URL.
- Invalid or non-absolute manifest URLs must throw, matching current `new URL(manifestUrl)` behavior.
- `appendAuthParams()` preserves existing query params and only appends missing auth params for same-origin URLs.
