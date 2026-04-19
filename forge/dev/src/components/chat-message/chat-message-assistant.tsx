import type { AgentTodo, ContentBlock, ToolCall } from "@/lib/types";
import { Markdown } from "../ui/markdown";
import { ToolCallGroup, SingleToolCall } from "./chat-message-tool-calls";
import { TodoProgress } from "./chat-message-todos";

export function DarkMarkdown({ text }: { text: string }) {
  return <Markdown theme="dark">{text}</Markdown>;
}

type RenderedItem =
  | { type: "text"; block: ContentBlock; key: number }
  | { type: "tools"; tools: ToolCall[]; key: number }
  | { type: "todos"; todos: AgentTodo[]; key: number };

function renderBlockItem(item: RenderedItem): React.ReactNode {
  switch (item.type) {
    case "text":
      return item.block.text ? <DarkMarkdown key={item.key} text={item.block.text} /> : null;
    case "tools":
      return item.tools.length === 1
        ? <SingleToolCall key={item.key} tc={item.tools[0]} />
        : <ToolCallGroup key={item.key} tools={item.tools} />;
    case "todos":
      return <TodoProgress key={item.key} todos={item.todos} />;
    default:
      return null;
  }
}

function groupBlocksByType(blocks: ContentBlock[]): RenderedItem[] {
  const result: RenderedItem[] = [];
  let pendingTools: ToolCall[] = [];
  let keyCounter = 0;

  function flushTools(): void {
    if (pendingTools.length === 0) return;
    // Sub-group consecutive tools by name
    let i = 0;
    while (i < pendingTools.length) {
      const name = pendingTools[i].name;
      const group: ToolCall[] = [];
      while (i < pendingTools.length && pendingTools[i].name === name) {
        group.push(pendingTools[i++]);
      }
      result.push({ type: "tools", tools: group, key: keyCounter++ });
    }
    pendingTools = [];
  }

  for (const block of blocks) {
    if (block.type === "tool" && block.toolCall) {
      pendingTools.push(block.toolCall);
    } else if (block.type === "todos" && block.todos) {
      flushTools();
      // Replace any previous todos block — only show the latest
      const prevIdx = result.findIndex((g) => g.type === "todos");
      if (prevIdx >= 0) result.splice(prevIdx, 1);
      result.push({ type: "todos", todos: block.todos, key: keyCounter++ });
    } else {
      flushTools();
      result.push({ type: "text", block, key: keyCounter++ });
    }
  }
  flushTools();

  return result;
}

export function AssistantBlocks({ blocks }: { blocks: ContentBlock[] }) {
  const items = groupBlocksByType(blocks);
  return <>{items.map(renderBlockItem)}</>;
}
