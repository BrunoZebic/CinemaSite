import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import type { HostActionEvent } from "@/lib/chat/types";
import { buildRoomBootstrap } from "@/lib/server/screenings";
import { getSupabaseAdminClient } from "@/lib/server/supabaseAdmin";

type RouteContext = {
  params: Promise<{
    room: string;
  }>;
};

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

export async function POST(request: NextRequest, context: RouteContext) {
  const { room } = await context.params;
  const bootstrap = await parseBootstrapFromRequest(request, room);

  if (!bootstrap.screening) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  if (!bootstrap.isHost) {
    return NextResponse.json(
      { error: "Host authorization required." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | {
        actionType?: unknown;
        targetSignature?: unknown;
        targetMessageId?: unknown;
      }
    | null;

  const actionType =
    body?.actionType === "mute_signature" ||
    body?.actionType === "unmute_signature" ||
    body?.actionType === "remove_message"
      ? body.actionType
      : null;

  if (!actionType) {
    return NextResponse.json(
      { error: "Invalid host action type." },
      { status: 400 },
    );
  }

  const targetSignature =
    typeof body?.targetSignature === "string"
      ? body.targetSignature.trim()
      : undefined;
  const targetMessageId =
    typeof body?.targetMessageId === "string"
      ? body.targetMessageId.trim()
      : undefined;

  if (
    (actionType === "mute_signature" || actionType === "unmute_signature") &&
    !targetSignature
  ) {
    return NextResponse.json(
      { error: "targetSignature is required for signature mute actions." },
      { status: 400 },
    );
  }

  if (actionType === "remove_message" && !targetMessageId) {
    return NextResponse.json(
      { error: "targetMessageId is required for remove action." },
      { status: 400 },
    );
  }

  const event: HostActionEvent = {
    id: randomUUID(),
    room: bootstrap.room,
    actionType,
    targetSignature,
    targetMessageId,
    ts: Date.now(),
    actor: "host",
  };

  const admin = getSupabaseAdminClient();
  if (admin) {
    await admin.from("host_actions").insert({
      id: event.id,
      room_slug: event.room,
      action_type: event.actionType,
      target_signature: event.targetSignature ?? null,
      target_message_id: event.targetMessageId ?? null,
      ts_unix_ms: event.ts,
      actor: event.actor,
    });
  }

  return NextResponse.json({ event });
}
