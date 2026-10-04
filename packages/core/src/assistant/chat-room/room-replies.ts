/**
 * ISS-727 — the shared half of the two room completion bridges. Everything here
 * is parameterized by the metadata marker so the bridges cannot drift; what
 * stays in each is only its own decision logic (Bao synthesis vs verbatim,
 * failover, fallback copy, progress source).
 */
import { and, eq, sql } from 'drizzle-orm';
import { claimSessionMetadataDelivery, messageRoleToTurnRole } from '../../agent-sessions/index.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';

type SessionRow = typeof agentSessions.$inferSelect;

export type RoomReplyMarker = 'escalation' | 'agentChat';

export interface RoomReplyMeta {
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
  askedByUsername: string;
  question: string;
  shape: 'direct' | 'group' | null;
  principalUserId: string | null;
  /** The token that person sent the question with, where they used one; null otherwise. */
  principalTokenId: string | null;
  deliveredAt: string | null;
}

export function readRoomReplyMeta(
  metadata: unknown,
  marker: RoomReplyMarker,
): RoomReplyMeta | null {
  const raw = (metadata as Record<string, unknown> | null)?.[marker];
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.connectionId !== 'string' ||
    typeof m.rid !== 'string' ||
    typeof m.botName !== 'string'
  ) {
    return null;
  }
  return {
    connectionId: m.connectionId,
    rid: m.rid,
    tmid: typeof m.tmid === 'string' ? m.tmid : null,
    botName: m.botName,
    askedByUsername: typeof m.askedByUsername === 'string' ? m.askedByUsername : '',
    question: typeof m.question === 'string' ? m.question : '',
    shape: m.shape === 'direct' || m.shape === 'group' ? m.shape : null,
    principalUserId: typeof m.principalUserId === 'string' ? m.principalUserId : null,
    principalTokenId: typeof m.principalTokenId === 'string' ? m.principalTokenId : null,
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : null,
  };
}

export async function claimRoomReplyDelivery(
  session: SessionRow,
  marker: RoomReplyMarker,
): Promise<boolean> {
  return claimSessionMetadataDelivery(session.id, marker);
}

export async function hasInFlightRoomSession(
  projectId: string,
  rid: string,
  marker: RoomReplyMarker,
  tmid?: string | null | undefined,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.metadata} -> ${marker}::text ->> 'rid' = ${rid}`,
        sql`${agentSessions.metadata} -> ${marker}::text ->> 'tmid' IS NOT DISTINCT FROM ${tmid ?? null}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export function extractFinalAssistantText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const entry = messages[i];
    if (messageRoleToTurnRole(entry) !== 'assistant') continue;
    const content = (entry as { content?: unknown }).content;
    if (typeof content === 'string' && content.trim().length > 0) return content.trim();
  }
  return null;
}
