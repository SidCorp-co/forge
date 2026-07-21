import { stripSystemNoise } from './content-filter.js';

const PREVIEW_MAX_CHARS = 140;

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

  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;

  const cleaned = stripSystemNoise(collapsed);
  if (!cleaned) return null;

  return cleaned.length > PREVIEW_MAX_CHARS
    ? `${cleaned.slice(0, PREVIEW_MAX_CHARS - 1)}…`
    : cleaned;
}
