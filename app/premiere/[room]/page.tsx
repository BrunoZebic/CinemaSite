import PremiereShell from "@/components/PremiereShell";
import { getPremiereConfig } from "@/lib/premiereConfig";

const SERVER_RENDER_EPOCH_MS = Date.now();

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
  const config = getPremiereConfig(normalizedRoom);

  return (
    <PremiereShell
      room={normalizedRoom}
      config={config}
      initialNowMs={SERVER_RENDER_EPOCH_MS}
    />
  );
}
