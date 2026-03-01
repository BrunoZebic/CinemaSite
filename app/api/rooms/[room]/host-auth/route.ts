import { NextRequest, NextResponse } from "next/server";
import {
  getScreeningConfig,
  screeningHasHostPassphrase,
  sha256Hex,
} from "@/lib/server/screenings";
import {
  createCookieConfig,
  createHostToken,
  getHostCookieName,
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

  if (!screeningHasHostPassphrase(screening)) {
    return NextResponse.json(
      { error: "Host auth is not configured for this room." },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as
    | { passphrase?: unknown }
    | null;
  const passphrase =
    typeof body?.passphrase === "string" ? body.passphrase.trim() : "";
  if (!passphrase) {
    return NextResponse.json(
      { error: "Host passphrase is required." },
      { status: 400 },
    );
  }

  const expectedHash = screening.hostPassphraseHash ?? "";
  const providedHash = sha256Hex(passphrase);
  if (providedHash !== expectedHash) {
    return NextResponse.json(
      { error: "Invalid host passphrase." },
      { status: 403 },
    );
  }

  const response = NextResponse.json({
    ok: true,
    isHost: true,
  });
  response.cookies.set(
    getHostCookieName(normalizedRoom),
    createHostToken(normalizedRoom),
    createCookieConfig(),
  );
  return response;
}
