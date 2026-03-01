import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { isValidNickname, normalizeNickname } from "@/lib/identity";
import { computePremierePhase, isChatOpenForPhase } from "@/lib/premiere/phase";
import type { ChatMessage } from "@/lib/chat/types";
import { buildRoomBootstrap, getScreeningConfig } from "@/lib/server/screenings";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type MessageRow = {
  id: string;
  room_slug: string;
  nickname: string;
  avatar_seed: string;
  text: string;
  ts_unix_ms: number;
  phase: string | null;
  signature: string | null;
};

type RouteContext = {
  params: Promise<{
    room: string;
  }>;
};

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    room: row.room_slug,
    nickname: row.nickname,
    avatarSeed: row.avatar_seed,
    text: row.text,
    ts: row.ts_unix_ms,
    phase:
      row.phase === "WAITING" ||
      row.phase === "LIVE" ||
      row.phase === "SILENCE" ||
      row.phase === "DISCUSSION" ||
      row.phase === "CLOSED"
        ? row.phase
        : undefined,
    signature: row.signature ?? undefined,
  };
}

async function parseBootstrapFromRequest(
  request: NextRequest,
  room: string,
) {
  const cookieValues: Record<string, string | undefined> = {};
  for (const cookie of request.cookies.getAll()) {
    cookieValues[cookie.name] = cookie.value;
  }

  return buildRoomBootstrap(room, cookieValues);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { room } = await context.params;
  const bootstrap = await parseBootstrapFromRequest(request, room);

  if (!bootstrap.screening) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  if (!bootstrap.hasAccess) {
    return NextResponse.json({ error: "Invite access required." }, { status: 403 });
  }

  const admin = getSupabaseAdminClient();
  if (!admin) {
    return NextResponse.json({ messages: [] });
  }

  const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "80");
  const limit = Number.isFinite(limitParam)
    ? Math.min(200, Math.max(1, Math.floor(limitParam)))
    : 80;

  const { data, error } = await admin
    .from("room_messages")
    .select("id,room_slug,nickname,avatar_seed,text,ts_unix_ms,phase,signature")
    .eq("room_slug", bootstrap.room)
    .order("ts_unix_ms", { ascending: true })
    .limit(limit);

  if (error || !data) {
    return NextResponse.json({ messages: [] });
  }

  return NextResponse.json({
    messages: (data as MessageRow[]).map(toMessage),
  });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { room } = await context.params;
  const normalizedRoom = room.trim().toLowerCase();
  const bootstrap = await parseBootstrapFromRequest(request, normalizedRoom);
  const screening = bootstrap.screening ?? (await getScreeningConfig(normalizedRoom));

  if (!screening) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  if (!bootstrap.hasAccess) {
    return NextResponse.json({ error: "Invite access required." }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | {
        id?: unknown;
        nickname?: unknown;
        avatarSeed?: unknown;
        text?: unknown;
        signature?: unknown;
      }
    | null;

  const nickname =
    typeof body?.nickname === "string" ? normalizeNickname(body.nickname) : "";
  const avatarSeed = typeof body?.avatarSeed === "string" ? body.avatarSeed : "";
  const rawText = typeof body?.text === "string" ? body.text : "";
  const text = rawText.replace(/\s+/g, " ").trim();
  const signature =
    typeof body?.signature === "string" ? body.signature.trim() : undefined;

  if (!isValidNickname(nickname)) {
    return NextResponse.json({ error: "Invalid nickname." }, { status: 400 });
  }

  if (!avatarSeed) {
    return NextResponse.json({ error: "Missing avatar seed." }, { status: 400 });
  }

  if (!text) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  if (text.length > screening.maxMessageChars) {
    return NextResponse.json(
      { error: `Message too long (max ${screening.maxMessageChars}).` },
      { status: 400 },
    );
  }

  const nowUnixMs = Date.now();
  const phase = computePremierePhase(nowUnixMs, screening);
  if (!isChatOpenForPhase(phase)) {
    return NextResponse.json(
      { error: "Chat is currently locked for this phase." },
      { status: 403 },
    );
  }

  const messageId =
    typeof body?.id === "string" && body.id.length > 4 ? body.id : randomUUID();

  const message: ChatMessage = {
    id: messageId,
    room: normalizedRoom,
    nickname,
    avatarSeed,
    text,
    ts: nowUnixMs,
    phase,
    signature,
  };

  const admin = getSupabaseAdminClient();
  if (admin) {
    await admin.from("room_messages").insert({
      id: message.id,
      room_slug: normalizedRoom,
      nickname: message.nickname,
      avatar_seed: message.avatarSeed,
      text: message.text,
      ts_unix_ms: message.ts,
      phase: message.phase,
      signature: message.signature ?? null,
    });
  }

  return NextResponse.json({ message });
}
