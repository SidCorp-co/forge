import type { AgentMessage, ContentBlock, ToolCall } from '../lib/agent-stream-parser.js';
import type { StoredConversationMessage } from './store.js';

const BLOCK_TYPES: ReadonlySet<unknown> = new Set<ContentBlock['type']>([
  'text',
  'tool',
  'todos',
  'thinking',
  'questionnaire',
  'questionnaire_answers',
  'designs',
  'visual',
  'unsupported',
]);

/** What a stored entry was, said in a word: its `type` where it names one, else what kind of value it is. */
function nameOf(entry: unknown): string {
  if (entry === null) return 'null';
  if (Array.isArray(entry)) return 'array';
  if (typeof entry !== 'object') return typeof entry;
  const type = (entry as { type?: unknown }).type;
  return typeof type === 'string' && type.length > 0 ? type : '(no type)';
}

/**
 * The blocks column, read back as blocks or as nothing. An entry whose type this build does not
 * know is kept as an `unsupported` block naming it, so a reader says "a hologram block" instead of
 * the part of the answer disappearing; the stored row is never rewritten.
 */
export function asBlocks(value: unknown): ContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const out: ContentBlock[] = value.map((b) =>
    b && typeof b === 'object' && BLOCK_TYPES.has((b as { type?: unknown }).type)
      ? (b as ContentBlock)
      : { type: 'unsupported', unsupported: nameOf(b) },
  );
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
