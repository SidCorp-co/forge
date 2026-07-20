const PREVIEW_MAX_CHARS = 140;

/**
 * A user turn's raw content is prefixed with a `[Context: …]` line
 * (`formatPageContextLine` in `page-context.ts`) before being sent to the
 * agent — strip it so the list preview reads as what the human actually said.
 */
const CONTEXT_LINE_RE = /^\[Context:[^\]]*\]\s*/;

function extractTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Derive a one-line last-message preview for a conversation-list row from a
 * turn's raw `content` jsonb. Mirrors `extractTextContent` in
 * `schedules/messages/skill-steward-prompt.ts` (string passthrough, or join
 * Anthropic-style `{type:'text'}` blocks) — tool-only turns have no text
 * block and correctly resolve to `null`.
 */
export function extractTurnPreview(content: unknown): string | null {
  const text = extractTextContent(content);
  if (!text) return null;

  const collapsed = text.replace(/\s+/g, ' ').trim().replace(CONTEXT_LINE_RE, '').trim();
  if (!collapsed) return null;

  return collapsed.length > PREVIEW_MAX_CHARS
    ? `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    : collapsed;
}
