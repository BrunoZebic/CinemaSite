# Live Cinema Premiere Platform (Week 1 Pilot)

Week 1 prototype for synchronous online premiere rooms with:
- nickname-only identity (localStorage)
- realtime room chat (Supabase Realtime broadcast)
- 3-state premiere flow (`WAITING`, `LIVE`, `ENDED`)
- slow mode anti-spam limiter

## Local Setup

1. Install dependencies:
```bash
npm install
```

2. Configure env vars in `.env.local`:
```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

3. Run local dev:
```bash
npm run dev
```

4. Open:
```text
http://localhost:3000/premiere/demo
```

## Scripts
- `npm run dev` - Start local development server.
- `npm run lint` - Run ESLint.
- `npm run build` - Build production bundle.
- `npm run start` - Start production server.

## Project Structure
- `app/premiere/[room]/page.tsx` - Dynamic premiere route.
- `components/PremiereShell.tsx` - Main room layout + state flow.
- `components/Chat/*` - Chat panel, composer, message list.
- `components/Identity/IdentityModal.tsx` - Nickname gate modal.
- `lib/premiereConfig.ts` - Config and state computation.
- `lib/chat/realtime.ts` - Supabase broadcast channel integration.
- `lib/chat/rateLimit.ts` - Slow mode + duplicate spam checks.

## Deployment (Vercel)
1. Push the repository to GitHub.
2. Import the repo in Vercel.
3. Add `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in Vercel project settings.
4. Deploy and verify `/premiere/demo`.
