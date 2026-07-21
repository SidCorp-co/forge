import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { logger } from '../logger.js';
import { callFastModel } from '../memory/llm.js';
import { broadcastSession } from './broadcast.js';
import { isSystemNoise, stripSystemNoise } from './content-filter.js';

const MAX_TITLE_CHARS = 60;
const TITLE_MAX_TOKENS = 24;

const TITLE_PROMPT = `Summarize the topic of the message below as a short title of 3 to 6 words, in the SAME language as the message. Describe what the message is about — do not answer it, do not restate it verbatim. Output ONLY the title, with no surrounding quotes or punctuation.

Message:
"""
{message}
"""

Title:`;

function postProcessTitle(raw: string): string | null {
  let title = raw
    .trim()
    .replace(/^["'\`]+|["'\`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title || isSystemNoise(title)) return null;
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trim();
  return title || null;
}

/**
 * Ask the deployment-configured fast model (`callFastModel`, LiteLLM
 * OpenAI-compat — same best-effort channel memory-v2 uses) for a short
 * (3-6 word) topic label for a conversation's first user message, in the
 * message's own language. Best-effort: returns `null` on any failure, empty
 * input, or a system-noise message — never throws.
 */
export async function generateSessionTitle(userMessage: string): Promise<string | null> {
  const sanitized = stripSystemNoise(userMessage.replace(/\s+/g, ' ').trim());
  if (!sanitized) return null;
  const raw = await callFastModel(TITLE_PROMPT.replace('{message}', sanitized), TITLE_MAX_TOKENS);
  if (!raw) return null;
  return postProcessTitle(raw);
}

export interface ApplyAutoTitleArgs {
  sessionId: string;
  userMessage: string;
  /** The synchronous `deriveChatTitle` value already persisted on the turn. */
  fallbackTitle: string;
}

/**
 * Fire-and-forget AI title upgrade, invoked AFTER the turn's own transaction
 * commits (never awaited by the caller — `void applyAutoTitleAsync(...)`).
 * Guards a user rename / fork-rerun title via compare-and-swap: the UPDATE
 * only takes when the title still equals the fallback this call was seeded
 * with, so a title that changed in the meantime is left untouched. Omits
 * `updatedAt` (schema has no `$onUpdate`) so list sort order is undisturbed.
 * Never throws — a failure here must not surface anywhere near the chat turn.
 */
export async function applyAutoTitleAsync(args: ApplyAutoTitleArgs): Promise<void> {
  try {
    const ai = await generateSessionTitle(args.userMessage);
    if (!ai || ai === args.fallbackTitle) return;
    const [row] = await db
      .update(agentSessions)
      .set({ title: ai })
      .where(and(eq(agentSessions.id, args.sessionId), eq(agentSessions.title, args.fallbackTitle)))
      .returning({
        id: agentSessions.id,
        projectId: agentSessions.projectId,
        deviceId: agentSessions.deviceId,
        status: agentSessions.status,
      });
    if (!row) return;
    broadcastSession(row, 'agent-session.updated');
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, sessionId: args.sessionId },
      'auto-title: failed to apply AI title',
    );
  }
}
