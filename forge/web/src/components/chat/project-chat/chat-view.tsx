'use client';

import { ChevronLeft, X, CircleDot } from 'lucide-react';
import { ChatInput } from '../chat-input';
import { ChatMessages } from '../chat-messages';
import type { ChatMessageData } from '../chat-message';

interface ChatViewProps {
  messages: ChatMessageData[];
  sessionTitle: string;
  sending: boolean;
  onSend: (text: string, files: File[]) => void;
  onBack: () => void;
  onClose: () => void;
  issueContext?: { id: number; title: string };
}

export function ChatView({ messages, sessionTitle, sending, onSend, onBack, onClose, issueContext }: ChatViewProps) {
  return (
    <div className="flex h-full flex-col chat-prose">
      {/* Header */}
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} className="shrink-0 p-2.5 text-outline hover:text-on-surface-variant transition-colors">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <h3 className="text-sm font-semibold truncate">{sessionTitle}</h3>
          </div>
          <button onClick={onClose} className="shrink-0 p-2.5 text-outline hover:text-on-surface-variant transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        {issueContext && (
          <div className="ml-9 mt-1 flex items-center gap-1.5 text-xs text-info">
            <CircleDot className="h-3 w-3 shrink-0" />
            <span className="truncate">ISS-{issueContext.id}: {issueContext.title}</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <ChatMessages messages={messages} variant="chat" />

      {/* Input */}
      <ChatInput onSend={onSend} disabled={sending} />
    </div>
  );
}
