/**
 * ISS-727 — the shared half of the two RC completion bridges. Everything here
 * is parameterized by the metadata marker so the bridges cannot drift; what
 * stays in each is only its own decision logic (Bao synthesis vs verbatim,
 * failover, fallback copy, progress source).
 */
import { and, eq, sql } from 'drizzle-orm';
import { messageRoleToTurnRole } from '../../agent-sessions/turns-helpers.js';
import { db } from '../../db/client.js';
import { agentSessions, integrationBindings } from '../../db/schema.js';
import { logger } from '../../logger.js';
import { decryptConnectionSecrets, findConnectionById } from '../store.js';
import type { RocketChatBindingConfig, RocketChatConfig, RocketChatSecrets } from './types.js';

type SessionRow = typeof agentSessions.$inferSelect;

export type RoomReplyMarker = 'escalation' | 'agentChat';

export interface RoomPostAuth {
  serverUrl: string;
  authToken: string;
  userId: string;
}

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

/** The room is still this project's to post into, right now. */
export async function roomStillBoundTo(args: {
  connectionId: string;
  projectId: string;
  rid: string;
}): Promise<boolean> {
  const rows = await db
    .select({ config: integrationBindings.config })
    .from(integrationBindings)
    .where(
      and(
        eq(integrationBindings.provider, 'rocketchat'),
        eq(integrationBindings.active, true),
        eq(integrationBindings.connectionId, args.connectionId),
        eq(integrationBindings.projectId, args.projectId),
      ),
    );
  return rows.some((r) => ((r.config ?? {}) as RocketChatBindingConfig).rids?.includes(args.rid));
}

export interface RoomReplyMeta {
  connectionId: string;
  rid: string;
  tmid: string | null;
  botName: string;
  askedByUsername: string;
  question: string;
  shape: 'direct' | 'group' | null;
  principalUserId: string | null;
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
    deliveredAt: typeof m.deliveredAt === 'string' ? m.deliveredAt : null,
  };
}

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
        sql`(${agentSessions.metadata} -> ${marker}::text ->> 'deliveredAt') IS NULL`,
      ),
    )
    .returning({ id: agentSessions.id });
  return claimed.length > 0;
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
