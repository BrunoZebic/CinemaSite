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
