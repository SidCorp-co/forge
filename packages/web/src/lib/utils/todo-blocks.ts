import type { ContentBlock, AgentTodo } from '@/components/message-bubble/chat-message';

type TodoWriteInput = { todos?: { content: string; status: string; activeForm?: string }[] };

/**
 * Converts a TodoWrite tool_use input to a todos ContentBlock.
 */
export function convertTodoWriteToTodosBlock(input: TodoWriteInput): ContentBlock & { type: 'todos' } {
  const todos = (input.todos ?? []).map((t): AgentTodo => ({
    content: t.content,
    status: (t.status as AgentTodo['status']) ?? 'pending',
    activeForm: t.activeForm,
  }));
  return { type: 'todos', todos };
}

/**
 * Deduplicates todos blocks in a ContentBlock array, keeping only the last one.
 */
export function deduplicateTodosBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const lastIdx = blocks.findLastIndex((b) => b.type === 'todos');
  if (lastIdx < 0) return blocks;
  return blocks.filter((b, i) => b.type !== 'todos' || i === lastIdx);
}
