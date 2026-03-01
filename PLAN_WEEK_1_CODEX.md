# PLAN_WEEK_1_CODEX

## Goal
Ship a deployed premiere-room prototype that proves synchronous attendance + realtime chat works across devices.

## Scope
- Next.js App Router + TypeScript app scaffold
- Route: `/premiere/[room]`
- Soft identity via localStorage (nickname + avatar seed)
- Supabase Realtime broadcast chat
- Slow mode + anti-spam guard
- Premiere state flow: `WAITING`, `LIVE`, `ENDED`
- Mobile chat drawer UX

## Core Deliverables
- Public deployed URL on Vercel
- Two-device cross-network realtime messaging
- Room-isolated channels (`premiere:${room}`)
- Countdown and state rendering by schedule
- No auth/email and no persistent message database

## Key Technical Decisions
- Client-only lightweight identity
- Broadcast event name: `message`
- Message payload fields:
  - `id`, `room`, `nickname`, `avatarSeed`, `text`, `ts`
- Cooldown enforced client-side with clear UI feedback
- Max message length and duplicate spam check

## Acceptance Criteria
- New user can join with nickname in under 10 seconds
- Two users in same room see instant messages
- Different rooms do not cross-talk
- Slow mode blocks spam attempts with clear reason
- Premiere countdown and state transitions render correctly

## Non-Goals
- Email/social auth
- Admin dashboard
- Persistent archive
- Streaming infrastructure
- Reactions/emoji/gifs
