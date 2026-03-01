import { NextRequest, NextResponse } from "next/server";
import { buildRoomBootstrap } from "@/lib/server/screenings";

type RouteContext = {
  params: Promise<{
    room: string;
  }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const { room } = await context.params;
  const cookieValues: Record<string, string | undefined> = {};

  for (const cookie of request.cookies.getAll()) {
    cookieValues[cookie.name] = cookie.value;
  }

  const bootstrap = await buildRoomBootstrap(room, cookieValues);
  return NextResponse.json(bootstrap, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
