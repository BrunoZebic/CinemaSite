import PremiereShell from "@/components/PremiereShell";
import { cookies } from "next/headers";
import { buildRoomBootstrap } from "@/lib/server/screenings";

type PremiereRoomPageProps = {
  params: Promise<{
    room: string;
  }>;
};

export default async function PremiereRoomPage({
  params,
}: PremiereRoomPageProps) {
  const { room } = await params;
  const normalizedRoom = room.toLowerCase();
  const cookieStore = await cookies();
  const cookieValues: Record<string, string | undefined> = {};

  for (const cookie of cookieStore.getAll()) {
    cookieValues[cookie.name] = cookie.value;
  }

  const initialBootstrap = await buildRoomBootstrap(normalizedRoom, cookieValues);

  return (
    <PremiereShell room={normalizedRoom} initialBootstrap={initialBootstrap} />
  );
}
