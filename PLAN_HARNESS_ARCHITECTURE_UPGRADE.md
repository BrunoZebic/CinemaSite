# PLAN_HARNESS_ARCHITECTURE_UPGRADE.md

**Status:** Approved — ready for implementation  
**Branch:** architectural-upgrade  
**Revision:** 2026-03-31

---

## Context

The test harness has grown organically across `tests/hls/`, `scripts/hls/`, and `lib/premiere/`. Three concrete structural problems are worth fixing now:

1. **Type duplication.** `PhaseUiSnapshot` lives only in `phase-transition-ui.spec.ts`. `PhaseTransitionKind`, `PhaseVisualState`, `ScreenVisualState`, `ChatVisualState` are re-declared locally in the spec, but are already exported from `lib/premiere/presentation.ts`. `PhaseName` is a local alias for `PremierePhase` from `lib/premiere/types.ts`.

2. **Env var resolution duplicated.** The `HLS_TEST_* ?? HLS_E2E_*` fallback pattern appears identically in `runRoomE2E.ts`, `phase-transition-ui.spec.ts`, and `room-playback.spec.ts`.

3. **Gate logic lives only in prose.** Which test scripts to run for which file paths is documented in AGENTS.md but encoded nowhere machine-readable.

Steps 4 (service extraction) and 5 (scenarios registry) follow once the above three are stable.

---

## Location rules

`lib/harness/` is for **pure shared things only** — types and static data with no Node, Playwright, or runtime dependencies.

| File | Location | Reason |
|------|----------|--------|
| `probe-contract.ts` | `lib/harness/` | Pure types, no runtime |
| `gates.ts` | `lib/harness/` | Pure data, no runtime |
| `scenarios.ts` | `lib/harness/` | Pure data, no runtime |
| `context.ts` | `scripts/hls/` | Reads `process.env`, Node concerns |
| `probe.ts` | `tests/hls/support/` | Depends on Playwright `Page` |
| `artifacts.ts` | `tests/hls/support/` | Depends on Playwright `TestInfo` |
| `access.ts` | `tests/hls/support/` | Depends on Playwright `BrowserContext` |

### Import path rules

- **All imports** in `scripts/hls/` and `tests/hls/` must use **relative paths** (e.g. `../../scripts/hls/env`, `../../../lib/harness/probe-contract`).
- Do **not** use `@/` path aliases in harness or test files. The `@/` alias is a Next.js convention and can fail in plain Node/tsx and Playwright contexts.
- `lib/harness/` files may use `@/lib/premiere/...` only if the build tool for that context resolves `@/` correctly — when in doubt, use relative imports there too.

---

## Step 1 — lib/harness/probe-contract.ts

**What:** Shared type module. `PhaseUiSnapshot` moves here. The spec-local aliases that duplicate `lib/premiere/presentation.ts` exports are removed.

```ts
import type { PremierePhase } from "../premiere/types";
import type {
  ChatVisualState,
  PhaseTransitionKind,
  PhaseVisualState,
  ScreenVisualState,
} from "../premiere/presentation";

// Re-export so consumers import from one place
export type { PremierePhase, ChatVisualState, PhaseTransitionKind, PhaseVisualState, ScreenVisualState };

export type PhaseProbeState = {
  playbackStartState?: string;
  isPrimed?: boolean;
};

export type PhaseUiSnapshot = {
  phase: PremierePhase | null;
  countdownLabel: string | null;
  shellPhase: PremierePhase | null;
  phaseVisualState: PhaseVisualState | null;
  transitionKind: PhaseTransitionKind | null;
  playerPhaseVisualState: PhaseVisualState | null;
  playerTransitionKind: PhaseTransitionKind | null;
  chatOpen: string | null;
  chatPhase: string | null;
  chatVisualState: ChatVisualState | null;
  screenVisualState: ScreenVisualState | null;
  playerFullscreen: string | null;
  waitingLobbyVisible: boolean;
  silenceBlackoutVisible: boolean;
  gestureVisible: boolean;
  recoveryRetryVisible: boolean;
  subtitleToggleVisible: boolean;
  posterVisible: boolean;
  staticTreatmentVisible: boolean;
  footerDisplayState: string | null;
  footerText: string;
  composerDisabled: boolean;
  inviteVisible: boolean;
  identityVisible: boolean;
  probe: PhaseProbeState | null;
};
```

**Files modified:**
- CREATE: `lib/harness/probe-contract.ts`
- MODIFY: `tests/hls/phase-transition-ui.spec.ts` — remove local `PhaseName`, `PhaseTransitionKind`, `PhaseVisualState`, `ScreenVisualState`, `ChatVisualState`, `PhaseUiSnapshot`, `PhaseProbeState` declarations; add `import type { PhaseUiSnapshot, PhaseProbeState, PhaseTransitionKind, PhaseVisualState, ScreenVisualState, PremierePhase } from "../../lib/harness/probe-contract"`; replace `PhaseName` references with `PremierePhase`
- MODIFY: `tests/hls/room-playback.spec.ts` — `VideoDiagnostics` already uses `string | null` for player transition fields; no type shape change, but import `PhaseTransitionKind`/`PhaseVisualState` from `../../lib/harness/probe-contract` if currently re-declared locally

**Not moving:** `HlsE2EProbeState` stays in `HlsSyncPlayer.tsx` — it references ~8 internal union types (`HlsPlaybackEngine`, `HlsRecoveryState`, etc.) that belong to the video subsystem. Window global augmentation stays there too.

---

## Step 2 — scripts/hls/context.ts

**What:** Single function that resolves the three core env vars. Eliminates the duplicated `HLS_TEST_* ?? HLS_E2E_*` pattern. Lives in `scripts/hls/` (not `lib/`) because it calls `loadLocalEnv()` and reads `process.env`.

```ts
import { loadLocalEnv } from "./env";

export type HarnessContext = {
  room: string;
  baseUrl: string;
  inviteCode: string;
};

export function loadHarnessContext(): HarnessContext {
  loadLocalEnv();
  const room =
    process.env.HLS_TEST_ROOM?.trim() ?? process.env.HLS_E2E_ROOM?.trim() ?? "demo";
  const baseUrl =
    process.env.HLS_TEST_BASE_URL?.trim() ??
    process.env.HLS_E2E_BASE_URL?.trim() ??
    "http://localhost:3100";
  const inviteCode =
    process.env.HLS_TEST_INVITE_CODE?.trim() ??
    process.env.HLS_E2E_INVITE_CODE?.trim() ??
    "";
  return { room, baseUrl, inviteCode };
}
```

Use **relative imports** throughout (`./env`, not `@/scripts/hls/env`) to avoid Next.js path resolution differences when running in Node/tsx contexts.

**Files modified:**
- CREATE: `scripts/hls/context.ts`
- MODIFY: `tests/hls/phase-transition-ui.spec.ts` — replace `loadLocalEnv()` + `const ROOM/BASE_URL/INVITE_CODE` block with `const { room: ROOM, baseUrl: BASE_URL, inviteCode: INVITE_CODE } = loadHarnessContext();`; import with relative path `../../scripts/hls/context`
- MODIFY: `tests/hls/room-playback.spec.ts` — same substitution for the three core vars; tuning vars (`IDLE_DELAY_MS`, etc.) stay as-is
- MODIFY: `scripts/hls/runRoomE2E.ts` — keep CLI-flag override logic; use `loadHarnessContext()` as the env-var fallback layer (replace the inline `process.env.HLS_TEST_ROOM?.trim() ?? process.env.HLS_E2E_ROOM?.trim()` chains)

---

## Step 3 — lib/harness/gates.ts

**What:** Machine-readable gate map derived from AGENTS.md §3.2–3.3. Includes the always-run baseline. This is intentionally conservative at the path level: overlapping triggers are expected, and touching one directory may require multiple suites. No existing files are modified — this is a new data source for future tooling.

```ts
export type GateDescriptor = {
  /** pnpm script name */
  script: string;
  description: string;
  /**
   * File path prefixes that trigger this gate.
   * Empty array = always runs.
   * Triggers across gates may overlap — a changed file can trigger multiple gates.
   */
  triggers: string[];
};

export const GATES: Record<string, GateDescriptor> = {
  lint: {
    script: "lint",
    description: "ESLint — runs on all PRs",
    triggers: [],
  },
  build: {
    script: "build",
    description: "Next.js build — runs on all PRs",
    triggers: [],
  },
  hlsPlayback: {
    script: "test:hls:bunny",
    description: "HLS playback smoke against Bunny CDN",
    triggers: [
      "lib/video/",
      "components/Video/",
      "app/api/rooms/",
    ],
  },
  phaseTransition: {
    script: "test:hls:phase",
    description: "Phase transition UI E2E",
    triggers: [
      "lib/premiere/",
      "components/PremiereShell",
      "components/Video/",
      "components/Chat/",
    ],
  },
  roomPlayback: {
    script: "test:hls:room",
    description: "Room playback, invite, and gesture E2E",
    triggers: [
      "app/premiere/",
      "components/Access/",
      "components/Video/",
      "app/api/rooms/",
    ],
  },
};
```

**Notes on trigger design:**
- `hlsPlayback` covers HLS adapter, Bunny signing/token/access, autoplay/gesture, and playback-start gating paths. `app/api/rooms/` is intentionally included because bootstrap/access changes can affect whether playback starts at all.
- `phaseTransition` covers `lib/premiere/phase.ts` (via `lib/premiere/`), `components/PremiereShell.tsx`, and the phase-gated surfaces in `components/Video/` and `components/Chat/` per AGENTS.md §3.3.
- `roomPlayback` includes `components/Video/` on purpose. Gesture CTA / priming UI lives there, and AGENTS.md §3.2 requires the room suite when invite/gesture UI or room flow changes.
- `components/Video/` appearing in all three suites is intentional. The gate map should err on the side of running too many required suites rather than missing one.
- Verify all trigger paths against the AGENTS.md §10.1 subsystem registry before committing.

---

## Step 4 — Extract probe/artifact/access services

**Precondition:** Do not start Step 4 until Steps 1–3 each pass `pnpm lint` and `pnpm build`.

**What:** Move three infrastructure helpers out of spec files into `tests/hls/support/`. The *story* helpers (`waitForSteadyPhase`, `waitForTransitionKind`, `resolveWaitingBranch`, `assertInitialPhaseState`) stay in the spec.

**New file: `tests/hls/support/probe.ts`**
- Exports `readPhaseUiSnapshot(page: Page): Promise<PhaseUiSnapshot>`
- Moves the 70-line `page.evaluate()` DOM query from `phase-transition-ui.spec.ts:157–234`
- Imports: `import type { PhaseUiSnapshot, PhaseProbeState } from "../../../lib/harness/probe-contract"` (relative, not `@/`)

**New file: `tests/hls/support/artifacts.ts`**
- Exports `attachDiagnostics(page: Page, testInfo: TestInfo, reason: string, room: string, authKeys: Set<string>): Promise<void>`
- The caller is responsible for building and passing `authKeys` (e.g. `buildAuthKeySet(process.env.HLS_AUTH_KEYS_EXTRA ?? null)`). `artifacts.ts` does **not** call `buildAuthKeySet` internally — accept as parameter only, never build internally.
- Imports (all relative from `tests/hls/support/`):
  - `import { redactUnknown } from "../../../scripts/hls/redact"`
  - `import { getCiRoomConfig } from "../../../scripts/hls/ciRoomHelper"`
- Moves the `attachDiagnostics` body from `phase-transition-ui.spec.ts:236–272`

**New file: `tests/hls/support/access.ts`**
- Exports `grantInviteAccess(context: BrowserContext, roomAccessUrl: string, inviteCode: string): Promise<void>`
- Exports `seedIdentityBeforeNavigation(page: Page, identity: object, storageKey: string): Promise<void>`
- Moves helpers from `phase-transition-ui.spec.ts:112–155`
- Parameters are made explicit (no closed-over module-level constants) so the functions are independently testable

**Files modified:**
- MODIFY: `tests/hls/phase-transition-ui.spec.ts` — remove extracted functions, add imports from `./support/*`; `openPhaseRoom` stays (it orchestrates the helpers and is part of the test story)
- MODIFY: `tests/hls/room-playback.spec.ts` — `readVideoDiagnostics` stays (reads broader shape than `PhaseUiSnapshot`); replace `attachDiagnostics` if signatures align, otherwise leave

---

## Step 5 — lib/harness/scenarios.ts

**What:** Minimal registry. Pure data, no runtime concerns. Stays lean.

```ts
export type ScenarioDescriptor = {
  spec: string;
  project: string;
  requiredEnv: string[];
  roomCapabilities: string[];
};

export const SCENARIOS = {
  roomPlayback: {
    spec: "tests/hls/room-playback.spec.ts",
    project: "room-e2e-chromium",
    requiredEnv: ["HLS_TEST_INVITE_CODE"],
    roomCapabilities: [],
  },
  phaseTransition: {
    spec: "tests/hls/phase-transition-ui.spec.ts",
    project: "room-e2e-chromium",
    requiredEnv: ["HLS_TEST_INVITE_CODE"],
    roomCapabilities: ["posterField", "minFilmDuration60"],
  },
} satisfies Record<string, ScenarioDescriptor>;
```

`runRoomE2E.ts` and `playwright.config.ts` can read default spec and project from here. No further fields added until there is a concrete use case.

---

## Invariants to preserve

- `phase-transition-ui.spec.ts` runs serial; `beforeAll`/`afterAll` room mutation pattern must not change.
- `loadLocalEnv()` is idempotent (already-set env vars are never overwritten). Do not add new unnecessary direct calls to it — `loadHarnessContext()` calls it once. The invariant is "don't add new callers without good reason," not "never call it twice."
- Diagnostic `catch(() => fallback)` pattern in `room-playback.spec.ts` `attachDiagnostics` call site must be preserved.

---

## Validation (run after each step)

1. `pnpm lint`
2. `pnpm build`
3. After step 4: `pnpm test:hls:unit`
4. `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
5. `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
