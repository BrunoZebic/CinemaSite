Updated Project Guideline (Living Doc)
What we are building (unchanged)

A scheduled, synchronized online screening ritual:

People enter a room before a fixed start time

Film plays in sync (late joiners catch up, no rewind in LIVE)

Silence phase (black screen, chat locked)

Discussion phase (minimal, calm)

Room closes; archive preserved internally

We are not building a streaming library or a social network.

Current implementation status (as of Week 2 shipped)

Already implemented

Next.js App Router + TS on Vercel

Supabase (DB + Realtime) backing

/premiere/[room] route

Invite-only access gate (signed HttpOnly cookies)

Host passphrase authorization (cookie)

Canonical server time endpoint and client offset

Premiere phase machine:

WAITING, LIVE, SILENCE, DISCUSSION, CLOSED

Persisted:

messages

host actions

Reconnect watchdog + bootstrap refetch + resync

Vimeo sync + drift correction logic (Week 2)

Operating principle now enforced

Server authority over access + phase + writes

Client is a view + controlled participant, not a source of truth

Screening Experience Protocol (tightened)

WAITING (Lobby)

Countdown visible

Video preloads but stays paused (no autoplay)

Chat may be allowed or locked (operator choice; default: allowed with slow mode)

LIVE

Video plays from canonical start time

No scrubbing

Drift correction loop active

Late joiners sync to canonical time (clamped)

SILENCE

Black screen

Video paused

Drift correction disabled

Chat locked (recommended)

DISCUSSION

Video hidden or optional replay (default off)

Chat open, minimalist

Moderation active

CLOSED

Room locked to read-only or fully closed

Archive preserved internally (not publicly searchable)

Moderation philosophy (unchanged, but now operationalized)

Allowed:

Sincere reflections, confusion, disagreement, emotional reactions
Removed:

Spam, harassment, profanity directed at users, off-topic floods

Moderation = protect the room, not enforce taste.

Implementation note (current):

Host privileges exist + host actions persist and broadcast

Next step later (not required now): moderator tools UI (mute/remove)

Technical MVP requirements (updated)

Playback

Canonical time source from server

Client uses server offset clock

In LIVE:

hard seek if drift > 2s

bounded soft correction when supported

In SILENCE:

forced pause + screen black + drift loop off

Reconnect:

bootstrap refresh → phase refresh → resync immediately

Chat

Persisted chronological messages

No threading, likes, emojis, typing indicators

Slow mode / anti-spam (client UX + server validation where relevant)

Archive

Stored in DB tagged by screening + film

Internal access only (still not publicly searchable)

Week 3 addition: HLS Playback Provider (new section)

Goal: replace Vimeo with HLS while keeping the same sync semantics.

New screening config fields

video_provider: 'vimeo' | 'hls'

video_manifest_url required when provider is hls (server-validated)

HLS compatibility

Safari/iOS uses native HLS

Other browsers use hls.js

Operational requirement

Hosting must provide proper MIME types, CORS, and Range requests.

Security decision (must be explicit)

For Screening #2, decide whether HLS URLs are:

public-but-unlisted (acceptable risk) OR

signed / gated delivery (recommended)

What NOT to do (still true)

No profiles, no social graph, no permanent library, no gamification, no heavy UI polish over function.

Metrics to track internally (unchanged)

Attendance, completion, retention into discussion, % who write, return rate.