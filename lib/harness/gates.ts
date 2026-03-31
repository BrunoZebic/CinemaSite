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
