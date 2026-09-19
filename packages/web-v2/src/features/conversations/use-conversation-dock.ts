"use client";


import { usePersistedState } from "@/lib/utils/use-persisted-state";

export function useConversationDock() {
  const [chatOpen, setChatOpen] = usePersistedState("web-v2:agents-chat-open", false, {
    syncTabs: false,
  });
  const [chatWidth, setChatWidth] = usePersistedState<number>("web-v2:agents-chat-width", 420, {
    syncTabs: false,
  });
  return { chatOpen, setChatOpen, chatWidth, setChatWidth };
}
