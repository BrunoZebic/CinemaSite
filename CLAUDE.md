# CLAUDE.md — Agent Contract

This file is the Claude Code entry point. The full agent contract is in [AGENTS.md](AGENTS.md) and applies to all agents working in this repo — Claude Code, Codex, or otherwise. Read it before starting any task.

## Critical rules (inline for immediate context)

**Product doctrine:** This is a scheduled, synchronized online screening ritual. Not a streaming library, social network, or social app. If a feature looks like discovery, reactions, feeds, or profiles — stop and ask.

**Plan-first:** Every implementation task requires a `PLAN_*` file before any code is written. Implementation must match the locked plan exactly. If the plan needs to change, update it first.

**Test gates by change type** (triggers may overlap — a single change can require multiple suites):
- All PRs: `pnpm lint` + `pnpm build`
- `lib/video/`, `components/Video/`, `app/api/rooms/`: `pnpm test:hls:bunny -- --room demo`
- `lib/premiere/`, `components/PremiereShell`, `components/Video/`, `components/Chat/`: `pnpm test:hls:phase -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`
- `app/premiere/`, `components/Access/`, `components/Video/`, `app/api/rooms/`: `pnpm test:hls:room -- --base-url http://localhost:3100 --room demo --project room-e2e-chromium`

The machine-readable version of this map is in [lib/harness/gates.ts](lib/harness/gates.ts).

**Stop and ask** before: schema changes, new runtime dependencies, phase machine rewrites, token relaxation, or anything that touches auth/session handling.

**Secrets:** Never print or commit Bunny CDN tokens, Supabase service role keys, or auth cookies. Use `.env.local` for local credentials.

## Full contract

See [AGENTS.md](AGENTS.md) for:
- Subsystem registry and testing maturity levels
- Change boundaries and rollback procedure
- Local test credential setup
- Final report template
- Stop-and-ask trigger list
