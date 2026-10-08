import { CONVERSATION_AGENT_MARKER, readSessionAsker } from '@forge/contracts/agent-sessions';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { type AgentSessionKind, agentSessions } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { forbidden, notFound } from '../middleware/route-errors.js';
import { holdersOf, holds, type ProjectPermission, requireHeld } from '../permissions/index.js';
import { refuseSession } from './refusals.js';
import { readTranscript } from './turns-helpers.js';

export const idParamSchema = z.object({ id: z.uuid() });

/**
 * A session row as the session routes answer it: with its whole transcript under `messages`,
 * read from the turn rows unless the caller already holds it.
 */
export async function withTranscript<T extends { id: string }>(
  row: T,
  messages?: readonly unknown[],
): Promise<T & { messages: readonly unknown[] }> {
  return { ...row, messages: messages ?? (await readTranscript(row.id)) };
}

/** Load the session row or 404 — the shared first step of every per-session guard. */
export async function loadSessionOr404(sessionId: string) {
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session) throw notFound('agent session not found');
  return session;
}

export async function ensureSessionMember(sessionId: string, userId: string) {
  const session = await loadSessionOr404(sessionId);
  const access = await loadProjectAccess(session.projectId, userId);
  requireHeld(access, 'project.read');
  return { session, access };
}

export async function ensureSessionRole(
  sessionId: string,
  userId: string,
  permission: ProjectPermission,
) {
  const session = await loadSessionOr404(sessionId);
  const access = await loadProjectAccess(session.projectId, userId);
  requireHeld(access, permission);
  return { session, access };
}

/**
 * Owner-or-admin gate shared by the session-owner mutating blocks: the session
 * owner may act on their own session; project owners/admins may act on any but a
 * conversation turn's, which is its asker's alone. Sessions with no owner
 * (userId = NULL, e.g. pipeline rows) pass.
 */
export function assertSessionOwnerOrAdmin(
  session: { userId: string | null; metadata: unknown },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
) {
  assertConversationTurnAsker(session, userId);
  if (session.userId && session.userId !== userId && !holds(access, 'project.admin')) {
    throw refuseSession(
      'SESSION_OWNER_FORBIDDEN',
      "only the session's owner or a holder of project.admin acts on another person's session",
    );
  }
}

/**
 * Full mutate guard used by /send, /abort, /cancel and DELETE: member-role
 * gate + session-owner-or-admin check on a freshly loaded session row.
 */
export async function ensureSessionOwnerOrAdmin(sessionId: string, userId: string) {
  const { session, access } = await ensureSessionRole(sessionId, userId, 'project.write');
  assertSessionOwnerOrAdmin(session, access, userId);
  return { session, access };
}

interface ChatSpecies {
  kind: AgentSessionKind;
  metadata: unknown;
}

/**
 * A chat a person opened (ISS-522): read only by its owner or a holder of project.admin. A chat a
 * schedule, an escalation or the conversation agent opened is written `unattended` by
 * `createChatSessionRow` and stays project-wide like every pipeline, master and run session.
 */
export function isOwnerPrivateChat(session: ChatSpecies): boolean {
  if (session.kind !== 'chat') return false;
  return (session.metadata as { unattended?: unknown } | null)?.unattended !== true;
}

/** The same predicate as a WHERE clause over `agent_sessions`. */
export const ownerPrivateChatSql = sql`(${agentSessions.kind} = 'chat' AND (${agentSessions.metadata}->>'unattended') IS DISTINCT FROM 'true')`;

/**
 * The person a conversation turn's session answers, where the session is one (REQ-32 criterion 6):
 * it ran as them, and its transcript holds the reply before the screen judged it and every tool's
 * input and output, so its transcript, its live frames and its held reply are theirs alone — no
 * other member of the room, and no holder of project.admin either. `undefined` for any other
 * session; null for a turn whose asker cannot be read, which nobody reads.
 */
export function conversationTurnAskerOf(session: {
  metadata: unknown;
  userId: string | null;
}): string | null | undefined {
  const marker = (session.metadata as Record<string, unknown> | null)?.[CONVERSATION_AGENT_MARKER];
  if (!marker || typeof marker !== 'object') return undefined;
  return readSessionAsker((marker as { asker?: unknown }).asker)?.userId ?? session.userId ?? null;
}

/** A conversation turn's session is listed to its asker alone, the reader `conversationTurnAskerOf` names. */
export function conversationTurnListedTo(viewerId: string): SQL {
  const marker = sql`${agentSessions.metadata} -> ${CONVERSATION_AGENT_MARKER}::text`;
  return sql`(${marker} IS NULL OR coalesce(${marker} -> 'asker' ->> 'userId', ${agentSessions.userId}::text) = ${viewerId})`;
}

/**
 * Who a session's live frames are for: a project-wide session's project room, or a person's own
 * chat's readers by name — its owner and every holder of project.admin, the people
 * `assertAgentChatOwner` admits — or a conversation turn's asker alone, so a frame never reaches a
 * socket the read would refuse.
 */
export interface SessionAudience {
  projectWide: boolean;
  userIds: string[];
}

export async function sessionAudience(
  session: ChatSpecies & { projectId: string; userId: string | null },
): Promise<SessionAudience> {
  const asker = conversationTurnAskerOf(session);
  if (asker !== undefined) return { projectWide: false, userIds: asker ? [asker] : [] };
  if (!isOwnerPrivateChat(session)) return { projectWide: true, userIds: [] };
  const admins = (await holdersOf('project.admin', [session.projectId])).get(session.projectId);
  const readers = new Set(admins ?? []);
  if (session.userId) readers.add(session.userId);
  return { projectWide: false, userIds: [...readers] };
}

/** `sessionAudience` for a caller holding only the id; a session that is gone has no audience. */
export async function sessionAudienceById(sessionId: string): Promise<SessionAudience> {
  const [row] = await db
    .select({
      projectId: agentSessions.projectId,
      userId: agentSessions.userId,
      kind: agentSessions.kind,
      metadata: agentSessions.metadata,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row ? sessionAudience(row) : { projectWide: false, userIds: [] };
}

export function assertAgentChatOwner(
  session: ChatSpecies & { userId: string | null },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
) {
  assertConversationTurnAsker(session, userId);
  if (!isOwnerPrivateChat(session)) return;
  if (session.userId !== userId && !holds(access, 'project.admin')) {
    throw refuseSession(
      'AGENT_CHAT_OWNER_FORBIDDEN',
      "only the conversation's owner or a holder of project.admin acts on another person's agent chat",
    );
  }
}

/** A conversation turn's session is read and acted on by its asker alone (`conversationTurnAskerOf`). */
export function assertConversationTurnAsker(
  session: { metadata: unknown; userId: string | null },
  userId: string,
) {
  const asker = conversationTurnAskerOf(session);
  if (asker === undefined || (asker !== null && asker === userId)) return;
  throw refuseSession(
    'CONVERSATION_TURN_ASKER_ONLY',
    "a conversation turn's session holds the reply before it was checked and every tool's input; only the person it answered reads it",
  );
}

/**
 * Device-principal scope guard: a CLI runner may touch ONLY the session that
 * was dispatched to it (ISS-462). Callers must have established that the
 * request's principal is a device before invoking.
 */
export function assertDeviceOwnsSession(
  c: Context<{ Variables: AuthVars }>,
  session: { deviceId: string | null },
) {
  if (session.deviceId !== c.get('deviceId')) {
    throw forbidden('device does not own this session');
  }
}
