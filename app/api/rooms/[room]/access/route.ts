import { NextRequest, NextResponse } from "next/server";
import { getScreeningConfig, screeningRequiresInvite, sha256Hex } from "@/lib/server/screenings";
import {
  createCookieConfig,
  createRoomAccessToken,
  getAccessCookieName,
} from "@/lib/server/session";

type RouteContext = {
  params: Promise<{
    room: string;
  }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { room } = await context.params;
  const normalizedRoom = room.trim().toLowerCase();
  const screening = await getScreeningConfig(normalizedRoom);

  if (!screening) {
    return NextResponse.json({ error: "Room not found." }, { status: 404 });
  }

  if (!screeningRequiresInvite(screening)) {
    const response = NextResponse.json({
      ok: true,
      hasAccess: true,
    });
    response.cookies.set(
      getAccessCookieName(normalizedRoom),
      createRoomAccessToken(normalizedRoom),
      createCookieConfig(),
    );
    return response;
  }

  const body = (await request.json().catch(() => null)) as
    | { inviteCode?: unknown }
    | null;
  const inviteCode =
    typeof body?.inviteCode === "string" ? body.inviteCode.trim() : "";
  if (!inviteCode) {
    return NextResponse.json(
      { error: "Invite code is required." },
      { status: 400 },
    );
  }

  const expectedHash = screening.inviteCodeHash ?? "";
  const providedHash = sha256Hex(inviteCode);
  if (providedHash !== expectedHash) {
    return NextResponse.json({ error: "Invalid invite code." }, { status: 403 });
  }

  const response = NextResponse.json({
    ok: true,
    hasAccess: true,
  });
  response.cookies.set(
    getAccessCookieName(normalizedRoom),
    createRoomAccessToken(normalizedRoom),
    createCookieConfig(),
  );
  return response;
}
