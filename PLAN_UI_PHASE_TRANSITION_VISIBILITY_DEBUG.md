# Plan: UI Phase Transition Visibility Debug

## Summary
- Make the room phase transitions intentionally long and unmistakable on the UI branch so manual testing can confirm the ritual animations are firing.

## Locked Decisions
- Preserve server-authoritative phase semantics, gating, and playback control behavior.
- Limit the change to presentation timing only.
- Use a dedicated phase-transition duration so pointer-driven chrome and other non-phase interactions keep their normal timing.

## Implementation
- Update `lib/premiere/presentation.ts` so the shell uses an exaggerated transition duration for phase changes.
- Expose the same duration to the room shell via a CSS custom property in `components/PremiereShell.tsx`.
- Update phase-transition selectors in `app/globals.css` to consume the dedicated duration and slightly lengthen the black pulse/reveal timing so the effect is visually obvious.

## Validation
- `pnpm lint`
- `pnpm build`
- `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
