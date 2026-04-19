import type { ChatMessageData } from '@/components/chat/chat-message';

/**
 * Create a new assistant message for streaming, or return the current one.
 */
export function getOrCreateAssistantMsg(
  streamingMsgId: React.MutableRefObject<string | null>,
  streamingTextRef: React.MutableRefObject<string>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>,
  setIsRunning: React.Dispatch<React.SetStateAction<boolean>>,
): string {
  if (streamingMsgId.current) return streamingMsgId.current;
  const id = crypto.randomUUID();
  streamingMsgId.current = id;
  streamingTextRef.current = '';
  setMessages((prev) => [...prev, {
    id,
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
    isStreaming: true,
    contentBlocks: [],
  }]);
  setIsRunning(true);
  return id;
}

/**
 * Finalize current assistant message and reset for next turn.
 */
export function finalizeAssistantMsg(
  streamingMsgId: React.MutableRefObject<string | null>,
  streamingTextRef: React.MutableRefObject<string>,
  setMessages: React.Dispatch<React.SetStateAction<ChatMessageData[]>>,
  opts?: { completeTodos?: boolean },
) {
  const msgId = streamingMsgId.current;
  if (msgId) {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msgId) return m;
        // When session completes, mark all todos as completed
        const finalBlocks = opts?.completeTodos
          ? m.contentBlocks?.map((b) =>
              b.type === 'todos'
                ? { ...b, todos: b.todos.map((t) => ({ ...t, status: 'completed' as const, activeForm: undefined })) }
                : b
            )
          : m.contentBlocks;
        return {
          ...m,
          isStreaming: false,
          toolCalls: m.toolCalls?.map((tc) => ({ ...tc, isStreaming: false })),
          contentBlocks: finalBlocks,
        };
      })
    );
  }
  streamingMsgId.current = null;
  streamingTextRef.current = '';
}
