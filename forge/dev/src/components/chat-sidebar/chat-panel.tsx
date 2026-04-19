'use client';

import { Button, PanelHeader, CloseButton } from "@/components/ui";
import { ChatInput } from "@/components/chat-input";
import { ChatMessageList } from "@/components/chat-message-list";
import type { ChatMessageData } from "@/lib/types";

interface ChatPanelProps {
  sessionTitle: string;
  messages: ChatMessageData[];
  sending: boolean;
  creating: boolean;
  onSend: (text: string, files: File[]) => void;
  onBack: () => void;
  onClose: () => void;
  onCreateIssue: () => void;
}

export function ChatPanel({ sessionTitle, messages, sending, creating, onSend, onBack, onClose, onCreateIssue }: ChatPanelProps) {
  const hasUserMessage = messages.some((m) => m.role === "user");

  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        className="px-4"
        left={
          <div className="flex items-center gap-2 min-w-0">
            <button onClick={onBack} className="shrink-0 text-gray-400 hover:text-gray-600">
              <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
            </button>
            <h3 className="text-sm font-semibold text-gray-900 truncate">{sessionTitle}</h3>
          </div>
        }
        right={<CloseButton onClick={onClose} />}
      />
      <ChatMessageList messages={messages} />
      {hasUserMessage && !sending && (
        <div className="border-t border-gray-200 px-4 py-2">
          <Button
            variant="primary"
            size="md"
            onClick={onCreateIssue}
            disabled={creating}
            className="w-full bg-blue-600 hover:bg-blue-700"
          >
            {creating ? "Creating..." : "Create Issue from Chat"}
          </Button>
        </div>
      )}
      <ChatInput onSend={onSend} disabled={sending} />
    </div>
  );
}
