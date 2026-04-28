import type { ChatMessageData, ToolCallData } from "@/lib/types";

export function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

export function parseStoredMessages(stored: any[]): ChatMessageData[] {
  return stored
    .filter((m) => {
      if (m.role === "user") return !(Array.isArray(m.content) && (m.content as any)[0]?.type === "tool_result");
      return m.role === "assistant";
    })
    .map((m, i) => {
      let content = "";
      const toolCalls: ToolCallData[] = [];
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "text") content += block.text || "";
          else if (block.type === "tool_use") {
            toolCalls.push({ id: block.id || `tool-${i}-${toolCalls.length}`, name: block.name || "tool", input: block.input });
          }
        }
      }
      return { id: `stored-${i}`, role: m.role as "user" | "assistant", content, timestamp: Date.now(), toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
    })
    .filter((m) => m.content || (m.toolCalls && m.toolCalls.length > 0));
}
