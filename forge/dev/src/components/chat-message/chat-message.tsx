import "highlight.js/styles/atom-one-dark.css";
import type { AgentMessage } from "@/lib/types";
import { DarkMarkdown, AssistantBlocks } from "./chat-message-assistant";
import { ToolCallGroup } from "./chat-message-tool-calls";

export function ChatMessage({ msg }: { msg: AgentMessage }) {
  if (msg.type === "user") {
    return (
      <div className="border-t border-[#333333] pt-3">
        <div className="flex items-start gap-2">
          <span className="font-mono text-sm text-[#cccccc] select-none shrink-0">❯</span>
          <div className="min-w-0 flex-1">
            <DarkMarkdown text={msg.content ?? ""} />
          </div>
        </div>
      </div>
    );
  }

  if (msg.type === "assistant") {
    if (msg.blocks && msg.blocks.length > 0) {
      return <AssistantBlocks blocks={msg.blocks} />;
    }
    const tools = msg.toolCalls ?? [];
    return (
      <div>
        {tools.length > 0 && <ToolCallGroup tools={tools} />}
        {msg.content && <DarkMarkdown text={msg.content} />}
      </div>
    );
  }

  if (msg.type === "system") {
    if (msg.subtype === "result" && msg.content) {
      return (
        <div className="border-t border-[#333333] pt-2 mt-2">
          <DarkMarkdown text={msg.content} />
        </div>
      );
    }
    return (
      <div className="font-mono text-xs text-[#666666] py-0.5">
        {msg.content}
      </div>
    );
  }

  if (msg.type === "tool_use") {
    return (
      <div className="flex items-center gap-1.5 font-mono text-xs py-0.5">
        <span className="text-[#cccccc]">⏵</span>
        <span className="text-[#cccccc]">{msg.toolName}</span>
      </div>
    );
  }

  return null;
}
