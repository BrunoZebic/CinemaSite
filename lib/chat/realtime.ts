import { type RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { isChatMessage, type ChatMessage } from "@/lib/chat/types";

let activeChannel: RealtimeChannel | null = null;
let activeRoom: string | null = null;

export function connectRoom(
  room: string,
  onMessage: (message: ChatMessage) => void,
): void {
  disconnectRoom();

  const supabase = getSupabaseClient();
  if (!supabase) {
    return;
  }

  const channelName = `premiere:${room}`;
  const channel = supabase.channel(channelName, {
    config: {
      broadcast: {
        self: true,
      },
    },
  });

  channel.on("broadcast", { event: "message" }, ({ payload }) => {
    if (!isChatMessage(payload)) {
      return;
    }
    onMessage(payload);
  });

  channel.subscribe((status) => {
    if (process.env.NODE_ENV !== "production") {
      console.info(`[chat] ${channelName}: ${status}`);
    }
  });

  activeChannel = channel;
  activeRoom = room;
}

export async function sendMessage(
  room: string,
  message: ChatMessage,
): Promise<void> {
  if (!activeChannel || activeRoom !== room) {
    throw new Error("Realtime channel is not connected for this room.");
  }

  const result = await activeChannel.send({
    type: "broadcast",
    event: "message",
    payload: message,
  });

  if (result !== "ok") {
    throw new Error(`Message broadcast failed (${result}).`);
  }
}

export function disconnectRoom(): void {
  if (!activeChannel) {
    return;
  }

  const channel = activeChannel;
  activeChannel = null;
  activeRoom = null;

  const supabase = getSupabaseClient();
  if (!supabase) {
    void channel.unsubscribe();
    return;
  }

  void supabase.removeChannel(channel);
}
