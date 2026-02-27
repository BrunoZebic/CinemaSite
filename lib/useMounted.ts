"use client";

import { useSyncExternalStore } from "react";

function subscribeNoop() {
  return () => {};
}

export function useMounted(): boolean {
  return useSyncExternalStore(subscribeNoop, () => true, () => false);
}
