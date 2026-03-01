import { type RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabaseClient";
import {
  isChatMessage,
  isHostActionEvent,
  type ChatMessage,
  type HostActionEvent,
} from "@/lib/chat/types";

export type ChannelHealthStatus =
  | "SUBSCRIBED"
  | "CHANNEL_ERROR"
  | "TIMED_OUT"
  | "CLOSED"
  | "DISCONNECTED";

type ConnectRoomOptions = {
  room: string;
  onMessage: (message: ChatMessage) => void;
  onModeration: (event: HostActionEvent) => void;
  onStatusChange?: (status: ChannelHealthStatus) => void;
  onHealthy?: () => void;
};

let activeChannel: RealtimeChannel | null = null;
let activeRoom: string | null = null;
let latestOptions: ConnectRoomOptions | null = null;
let activeStatus: ChannelHealthStatus = "DISCONNECTED";

function updateStatus(
  status: ChannelHealthStatus,
  options: ConnectRoomOptions | null,
) {
  activeStatus = status;
  options?.onStatusChange?.(status);
}

export function getChannelStatus(): ChannelHealthStatus {
  return activeStatus;
}

export function connectRoom(options: ConnectRoomOptions): void {
  disconnectRoom();
  latestOptions = options;

  const supabase = getSupabaseClient();
  if (!supabase) {
    updateStatus("DISCONNECTED", options);
    return;
  }

  const channelName = `premiere:${options.room}`;
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
    options.onMessage(payload);
  });

  channel.on("broadcast", { event: "moderation" }, ({ payload }) => {
    if (!isHostActionEvent(payload)) {
      return;
    }
    options.onModeration(payload);
  });

  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      updateStatus("SUBSCRIBED", options);
      options.onHealthy?.();
      return;
    }

    if (
      status === "CHANNEL_ERROR" ||
      status === "TIMED_OUT" ||
      status === "CLOSED"
    ) {
      updateStatus(status, options);
      return;
    }

    updateStatus("DISCONNECTED", options);
  });

  activeChannel = channel;
  activeRoom = options.room;
}

export function reconnectRoom(): void {
  if (!latestOptions) {
    return;
  }

  connectRoom(latestOptions);
}

export async function sendMessageBroadcast(
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

export async function sendModerationBroadcast(
  room: string,
  event: HostActionEvent,
): Promise<void> {
  if (!activeChannel || activeRoom !== room) {
    throw new Error("Realtime channel is not connected for this room.");
  }

  const result = await activeChannel.send({
    type: "broadcast",
    event: "moderation",
    payload: event,
  });

  if (result !== "ok") {
    throw new Error(`Moderation broadcast failed (${result}).`);
  }
}

export function disconnectRoom(): void {
  if (!activeChannel) {
    activeStatus = "DISCONNECTED";
    return;
  }

  const channel = activeChannel;
  activeChannel = null;
  activeRoom = null;
  activeStatus = "DISCONNECTED";

  const supabase = getSupabaseClient();
  if (!supabase) {
    void channel.unsubscribe();
    return;
  }

  void supabase.removeChannel(channel);
}
