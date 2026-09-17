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
// cm:guard validated on the way OUT for the same reason `asImages` is, and a row whose column holds
// something this cannot read comes back null — which `toCanonicalEntry` answers from `content`,
// so an illegible column degrades to the legacy reading rather than to an empty turn.
// cm:guard this list is NOT derived from `ContentBlock` and cannot be: the value is `unknown`, so a
// member added to that shape and not to this line is dropped here, on the way out of the database,
// with nothing on either side failing. `thinking` was that member for the length of one plan
// consult (ISS-1079). Anything added to `ContentBlock['type']` belongs on this line in the same
// change, and `store.test.ts` asserts each member by name for exactly that reason.
export function asBlocks(value: unknown): ContentBlock[] | null {
  if (!Array.isArray(value)) return null;
  const out: ContentBlock[] = [];
  for (const b of value) {
    if (!b || typeof b !== 'object') continue;
    const type = (b as { type?: unknown }).type;
    if (type === 'text' || type === 'tool' || type === 'todos' || type === 'thinking')
      out.push(b as ContentBlock);
  }
  return out.length > 0 ? out : null;
}

/**
 * One stored row, as the canonical transcript entry the rest of Forge reads
 * (ISS-1029) — the same `AgentMessage` shape `lib/agent-stream-parser.ts`
 * produces for the Claude Code CLI path, so one formatter renders both.
 */
// cm:guard `type` is DERIVED from `role` and `timestamp` from `created_at` rather than stored a
// second time: the row already answers both, and a column repeating them is a copy nothing keeps in
// step. This is the whole of the mapping, in one place, so a stored row and a streamed entry cannot
// disagree about what they are.
// cm:guard a row with no blocks becomes ONE text block off `content` and never an empty entry: every
// row written before ISS-1029 is that row, and an empty `blocks` would render them all as turns
// nobody answered.
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
