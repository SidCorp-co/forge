/**
 * The canonical transcript entry, read off a stored row.
 *
 * Split out of `store.ts` so the row-reading half and the shape-mapping half are
 * separately readable — nothing here touches the database, and the only thing it
 * needs from the store is the row type.
 */
import type { AgentMessage, ContentBlock, ToolCall } from '../lib/agent-stream-parser.js';
import type { StoredConversationMessage } from './store.js';

/** The blocks column, read back as blocks or as nothing. */
export function asBlocks(value: unknown): ContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const out: ContentBlock[] = [];
  for (const b of value) {
    if (!b || typeof b !== 'object') continue;
    const type = (b as { type?: unknown }).type;
    if (type === 'text' || type === 'tool' || type === 'todos') out.push(b as ContentBlock);
  }
  return out.length > 0 ? out : null;
}

/**
 * One stored row, as the canonical transcript entry the rest of Forge reads
 * (ISS-1029) — the same `AgentMessage` shape `lib/agent-stream-parser.ts`
 * produces for the Claude Code CLI path, so one formatter renders both.
 */
export function toCanonicalEntry(row: StoredConversationMessage): AgentMessage {
  const blocks: ContentBlock[] =
    row.blocks ?? (row.content.length > 0 ? [{ type: 'text', text: row.content }] : []);
  const toolCalls: ToolCall[] = [];
  for (const b of blocks) if (b.type === 'tool' && b.toolCall) toolCalls.push(b.toolCall);
  return {
    id: row.id,
    type: row.role === 'user' ? 'user' : row.role === 'system' ? 'system' : 'assistant',
    timestamp: row.createdAt.getTime(),
    ...(row.content.length > 0 ? { content: row.content } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
