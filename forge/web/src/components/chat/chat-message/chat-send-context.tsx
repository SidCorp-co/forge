'use client';

import { createContext, useContext } from 'react';

type SendFn = (message: string) => void;

const ChatSendContext = createContext<SendFn | null>(null);

export function ChatSendProvider({ send, children }: { send: SendFn; children: React.ReactNode }) {
  return <ChatSendContext.Provider value={send}>{children}</ChatSendContext.Provider>;
}

export function useChatSend(): SendFn | null {
  return useContext(ChatSendContext);
}
