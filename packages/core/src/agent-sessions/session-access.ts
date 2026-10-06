import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { loadProjectAccess } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';
import { forbidden, notFound } from '../middleware/route-errors.js';
import { holds, type ProjectPermission, requireHeld } from '../permissions/index.js';
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
 * owner may act on their own session; project owners/admins may act on any.
 * Sessions with no owner (userId = NULL, e.g. pipeline rows) pass.
 */
export function assertSessionOwnerOrAdmin(
  session: { userId: string | null },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
) {
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

export function assertAgentChatOwner(
  session: { metadata: unknown; userId: string | null },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
) {
  const isAgentChat = (session.metadata as { type?: string } | null)?.type === 'agent';
  if (!isAgentChat) return;
  if (session.userId !== userId && !holds(access, 'project.admin')) {
    throw refuseSession(
      'AGENT_CHAT_OWNER_FORBIDDEN',
      "only the conversation's owner or a holder of project.admin acts on another person's agent chat",
    );
  }
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
