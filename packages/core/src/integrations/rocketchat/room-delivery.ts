/**
 * ISS-727 — the shared half of the two RC completion bridges. Everything here
 * is parameterized by the metadata marker so the bridges cannot drift; what
 * stays in each is only its own decision logic (Bao synthesis vs verbatim,
 * failover, fallback copy, progress source).
 */
import { and, eq, sql } from 'drizzle-orm';
import { messageRoleToTurnRole } from '../../agent-sessions/turns-helpers.js';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import type { RocketChatConfig, RocketChatSecrets } from './types.js';

type SessionRow = typeof agentSessions.$inferSelect;

// cm:edge contract -> packages/core/src/lifecycle/transition.ts — the kernel's terminal-session writers fan out on exactly these marker keys, so adding a reply kind here needs a matching fire site there
export type RoomReplyMarker = 'escalation' | 'agentChat';

export interface RoomPostAuth {
  serverUrl: string;
  authToken: string;
  userId: string;
}

// cm:guard returns null rather than throwing — callers treat that as "cannot deliver" and fall back, and a throw here would escape the bridge's best-effort contract
export async function resolveRoomPostAuth(
  connectionId: string,
  logContext: Record<string, unknown>,
): Promise<RoomPostAuth | null> {
  const connection = await findConnectionById(connectionId);
  if (!connection) {
    logger.error({ ...logContext, connectionId }, 'rocketchat: connection not found');
    return null;
  }
  const secrets = decryptConnectionSecrets<RocketChatSecrets>(connection);
  const config = (connection.config ?? {}) as RocketChatConfig;
  if (!config.serverUrl || !secrets.authToken || !secrets.userId) {
    logger.error(
      { ...logContext, connectionId },
      'rocketchat: connection missing serverUrl/credentials',
    );
    return null;
  }
  return { serverUrl: config.serverUrl, authToken: secrets.authToken, userId: secrets.userId };
}

export interface RoomReplyMeta {
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
  askedByUsername: string;
  question: string;
  deliveredAt: string | null;
}

// cm:guard never coerce connectionId/rid/botName to a default — a missing one means "not a room-reply session", and defaulting it turns that into a delivery attempt against an empty room id
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
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : null,
  };
}

// cm:guard compare-and-set, so exactly one caller delivers even when the runner's happy-path PATCH and a kernel sweeper/failure hook race on the same session
// cm:guard the spread preserves unknown sibling keys — `agent-chat.ts`'s failover writes `metadata.agentChat.failover`, and rebuilding this object from RoomReplyMeta's fields alone would silently drop the attempt counter that bounds the retry
export async function claimRoomReplyDelivery(
  session: SessionRow,
  marker: RoomReplyMarker,
): Promise<boolean> {
  const prevMetadata = (session.metadata as Record<string, unknown>) ?? {};
  const prevMarker = (prevMetadata[marker] as Record<string, unknown>) ?? {};
  const nextMetadata = {
    ...prevMetadata,
    [marker]: { ...prevMarker, deliveredAt: new Date().toISOString() },
  };
  const claimed = await db
    .update(agentSessions)
    .set({ metadata: nextMetadata as never })
    .where(
      and(
        eq(agentSessions.id, session.id),
        // cm:guard the `::text` cast is load-bearing — Drizzle renders `${marker}` as a bind parameter, and `jsonb -> $1` with an untyped parameter is ambiguous in Postgres (`->` overloads on text and int), so it fails at runtime with "operator is not unique" rather than at build time
        sql`(${agentSessions.metadata} -> ${marker}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return claimed.length > 0;
}

// cm:guard DB-backed, never an in-memory Set — this must be instance-independent and self-clear the moment the session goes terminal via ANY writer
export async function hasInFlightRoomSession(
  projectId: string,
  rid: string,
  marker: RoomReplyMarker,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        eq(agentSessions.status, 'running'),
        sql`${agentSessions.metadata} -> ${marker}::text ->> 'rid' = ${rid}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// cm:guard two on-disk shapes exist (desktop carries `entry.role`, the CLI runner carries `entry.type`) and `messageRoleToTurnRole` is the canonical normalizer for both — do not re-derive the discriminator here
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
