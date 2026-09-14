"use client";

// Global conversation dock state (ISS-500, ported at ISS-1004 step 5): the "Ask
// agent" affordance lives in the header so a conversation can be opened from any
// screen. Open/closed and width are owned here and persisted per tab — opening
// it in one tab must not pop it open in every other one.
//
// The storage keys are the ones the chat dock used, unchanged: a person who had
// the panel open when this shipped keeps it open, and the value stored under
// each is the same shape it always was.

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
