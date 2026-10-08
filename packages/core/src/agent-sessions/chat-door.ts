/**
 * Whether a credential belongs to a chat door: the assistant answering in a conversation, or a
 * session on a paired box answering a person (Agent mode, the Agents screen, a room escalation), or
 * the token one proposal a person agreed to in a chat is written under (`assistant/agreement`).
 * The owner's ruling of 2026-10-08 is that no chat door files an issue — a wish or a report enters
 * as Feedback or a Requirement and issues come from those — so the issue kernel asks this before
 * the one insert into `issues`.
 */

import { eq } from 'drizzle-orm';
import { turnTokenOrigin } from '../credentials/pat-format.js';
import { db } from '../db/client.js';
import { agentSessions, personalAccessTokens } from '../db/schema.js';

export type ChatDoor =
  | { door: 'assistant-turn'; tokenId: string }
  | { door: 'box-session'; tokenId: string; sessionId: string }
  | { door: 'agreement'; tokenId: string; proposalId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A scheduled fire runs unattended on a turn token too; it is a run, not a chat, and keeps its rights. */
function isScheduleFire(metadata: unknown): boolean {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  return meta.source === 'schedule.run' || typeof meta.scheduleRunId === 'string';
}

/**
 * Whether a session on a paired box is a chat door: a chat-kind session that is not a schedule
 * fire. Its turn token files no issue, and the box runs it confined, holding that token and none
 * of the box's own — one set, so a session the issue kernel fences is never one whose shell can
 * reach a credential it does not fence.
 */
export function isChatDoorSession(session: { kind: string; metadata: unknown }): boolean {
  return session.kind === 'chat' && !isScheduleFire(session.metadata);
}

/**
 * The chat door `tokenId` was minted for, or null for any other credential. A `turn:<sessionId>`
 * token whose session row is gone is still a chat door's: only chat sessions are handed one.
 */
export async function chatDoorOfToken(tokenId: string): Promise<ChatDoor | null> {
  const [token] = await db
    .select({ name: personalAccessTokens.name })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.id, tokenId))
    .limit(1);
  const origin = token ? turnTokenOrigin(token.name) : null;
  if (!origin) return null;
  if (origin.door === 'assistant-turn') return { door: 'assistant-turn', tokenId };
  if (origin.door === 'agreement') {
    return { door: 'agreement', tokenId, proposalId: origin.proposalId };
  }
  const chat: ChatDoor = { door: 'box-session', tokenId, sessionId: origin.sessionId };
  if (!UUID_RE.test(origin.sessionId)) return chat;
  const [session] = await db
    .select({ kind: agentSessions.kind, metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(eq(agentSessions.id, origin.sessionId))
    .limit(1);
  if (session && !isChatDoorSession(session)) return null;
  return chat;
}
