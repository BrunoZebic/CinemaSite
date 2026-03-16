# Test Workflow Documentation Clarification

## Summary
- Document the expected local HLS validation workflow in one obvious place so future playback/UI passes do not rediscover the same room-state and environment quirks.
- Keep scope limited to documentation only. No test logic, workflows, or runtime behavior changes are included in this task.

## Goals
- Clarify the recommended local command order for:
  - `pnpm lint`
  - `pnpm build`
  - `pnpm test:hls:bunny -- --room demo`
  - `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
  - `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
- Capture known local caveats discovered during Week 4.5 validation:
  - phase tests mutate shared room timing and can leave `demo` outside the desired `LIVE` window for later playback assertions
  - local environments that define `HLS_TEST_SUBTITLE_ROOM` also execute the optional subtitle-room coverage inside the room suite
  - local room resets may need to cover both the main room and the subtitle room
  - running localhost-backed room and phase suites in parallel can collide on the local Playwright web server port

## Target Docs
- Update `README.md` under the existing Week 4 HLS self-test / CI guidance.

## Non-Goals
- No workflow YAML changes
- No AGENTS contract changes
- No test suite behavior changes

## Validation
- Run `pnpm lint`
- Run `pnpm build`
