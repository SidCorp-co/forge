"use client";

// Global Agent Chat dock state (ISS-500): the "Ask agent" affordance lives in
// the header so a conversation can be opened from any screen. The open/closed
// state is owned here (single source) and persisted per tab — reusing the key
// + `syncTabs: false` that the in-Agents-screen dock used (ISS-378 AC#7), so a
// tab that had it open keeps it; opening it in one tab must not pop it open in
// every other tab.
import { usePersistedState } from "@/lib/utils/use-persisted-state";

export function useChatDock() {
  const [chatOpen, setChatOpen] = usePersistedState("web-v2:agents-chat-open", false, {
    syncTabs: false,
  });
  // Docked-panel width (desktop split view). Per-tab so resizing one tab's panel
  // doesn't reflow another's.
  const [chatWidth, setChatWidth] = usePersistedState<number>("web-v2:agents-chat-width", 420, {
    syncTabs: false,
  });
  return { chatOpen, setChatOpen, chatWidth, setChatWidth };
}
