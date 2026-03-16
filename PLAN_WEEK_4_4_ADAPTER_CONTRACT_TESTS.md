# Week 4.4 Adapter Contract-Level Tests

## Summary
- Create a Node-testable HLS adapter core without changing user-facing playback behavior.
- Add contract-level unit coverage for helper logic, fake video readiness semantics, and fake Hls lifecycle wiring.
- Document the adapter contract for `READY`, `ERROR`, and the ownership boundary with `HlsSyncPlayer`.
- Add PR CI coverage for `pnpm test:hls:unit`.

## Key Changes
- Split `lib/video/hlsAdapter.ts` into:
  - `lib/video/hlsAdapterCore.ts` with no `"use client"`
  - `lib/video/hlsAdapter.ts` as the narrow `"use client"` wrapper for app imports
- Keep pure helpers in `hlsAdapterCore.ts` only:
  - `DEFAULT_HLS_AUTH_PARAM_NAMES`
  - `HlsManifestAuthContext`
  - `buildManifestAuthContext(...)`
  - `appendAuthParams(...)`
  - `mapHlsFatalEvent(...)`
  - `normalizeSeekTarget(...)`
- Replace `window.setTimeout` / `window.clearTimeout` in `waitUntilReady()` with bare timers.
- Add an internal Hls runtime seam so unit tests can provide a fake `isSupported`, `Events`, `DefaultConfig.loader`, and `create(...)` implementation.
- Add `lib/video/hlsAdapterSemantics.md`.
- Add unit coverage:
  - `tests/hls/unit/hls-adapter-helpers.test.ts`
  - `tests/hls/unit/hls-adapter-contract.test.ts`
  - `tests/hls/unit/support/hlsAdapterFakes.ts`
- Update `.github/workflows/pr-quality.yml` with a parallel `hls-unit` job.

## Test Plan
- Tier 1 helper tests:
  - same-origin auth params appended for relative and absolute URLs
  - existing auth params preserved and never overwritten
  - cross-origin URLs unchanged
  - invalid raw URLs returned unchanged by `appendAuthParams`
  - `buildManifestAuthContext` throws on malformed or non-absolute manifest URLs
  - `401/403` are treated as fatal even when `data.fatal === false`
  - fatal non-forbidden errors map status/details correctly
  - nonfatal non-forbidden errors return `null`
  - seek normalization covers negative, `NaN`, and finite values
- Tier 2 fake video contract tests:
  - native-path READY resolves only after metadata plus reliable-seek conditions
  - buffering flips `true` on `waiting`/`stalled` and back `false` on `canplay`/`playing`
  - timeout rejection includes the current stage using `node:test` mock timers
  - after `destroy()`, late media events do not change readiness, buffering, fatal state, or stage from `INIT`
- Tier 3 fake Hls wiring tests:
  - initialize order is `loadSource` then `attachMedia`
  - destroy order is `detachMedia` then `destroy`
  - `MEDIA_ATTACHED` plus `MANIFEST_PARSED` plus metadata/seekability is the READY path
  - fatal mapping rules are exercised through emitted Hls events
  - after `destroy()`, late Hls callbacks do not mutate state or notify listeners

## Assumptions
- CI visibility for this step means PR feedback via `.github/workflows/pr-quality.yml`.
- This remains a Level 5 subsystem; no `AGENTS.md` maturity-table change is required.
- Unit tests import `lib/video/hlsAdapterCore.ts` directly; app code continues importing `lib/video/hlsAdapter.ts`.
- Required implementation validation is `pnpm test:hls:unit`, `pnpm lint`, `pnpm build`, and `pnpm test:hls:bunny -- --room demo`.
- After the change passes the required gates, finish on a dedicated task branch with commit and push.
