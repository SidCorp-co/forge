import type { ChatMessageData, ContentBlock, ToolCallData } from '../chat-message';
import { convertTodoWriteToTodosBlock, deduplicateTodosBlocks } from '@/lib/utils/todo-blocks';

export function deserializeMessages(stored: any[]): ChatMessageData[] {
  return stored
    .filter((m: any) => {
      if (m.role === 'user') return !(Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
      return m.role === 'assistant';
    })
    .map((m: any, i: number) => {
      let content = '';
      const toolCalls: ToolCallData[] = [];
      const contentBlocks: ContentBlock[] = [];
      if (typeof m.content === 'string') {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text') {
            content += block.text;
            contentBlocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use' && block.name === 'TodoWrite') {
            const todosBlock = convertTodoWriteToTodosBlock(block.input ?? {});
            if (todosBlock.todos.length) {
              contentBlocks.push(todosBlock);
            }
          } else if (block.type === 'tool_use') {
            const tc: ToolCallData = {
              id: block.id || `tool-${i}-${toolCalls.length}`,
              name: block.name,
              input: block.input,
            };
            toolCalls.push(tc);
            contentBlocks.push({ type: 'tool_use', tool: tc });
          }
        }
      }
      return {
        id: `stored-${i}`,
        role: m.role as 'user' | 'assistant',
        content,
        timestamp: Date.now(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        contentBlocks: contentBlocks.length > 0 ? deduplicateTodosBlocks(contentBlocks) : undefined,
      };
    })
    .filter((m: ChatMessageData) => m.content || (m.toolCalls && m.toolCalls.length > 0) || (m.contentBlocks && m.contentBlocks.length > 0));
}
