"use client";

import { ChatScreen } from "@/features/conversations/components/chat-screen";

// cm:why the screen lives in the layout, which Next keeps mounted across /chat, /chat/<slug> and /chat/<slug>/<id>; a page would remount on each, and a draft's first send moves the route while its message is still in flight
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ChatScreen />
      {children}
    </>
  );
}
