import type { AgentMessage } from "@/lib/types";
import { ChatMessage } from "./chat-message";
import { DiffSummary } from "./chat-message/diff-summary";
import { useScrollToBottom } from "@/hooks/use-scroll-to-bottom";

interface Props {
  messages: AgentMessage[];
}

export function ChatView({ messages }: Props) {
  const { containerRef, bottomRef, handleScroll } = useScrollToBottom([messages]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex flex-1 flex-col gap-3 overflow-y-auto bg-[#0c0c0c] p-4"
    >
      {messages.map((msg) => (
        <ChatMessage key={msg.id} msg={msg} />
      ))}
      <DiffSummary messages={messages} />
      <div ref={bottomRef} />
    </div>
  );
}
