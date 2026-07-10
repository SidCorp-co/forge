import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { type ProjectMemberRole, agentSessions } from '../db/schema.js';
import { assertProjectRole, loadProjectAccess, projectRoleAtLeast } from '../lib/authz.js';
import type { AuthVars } from '../middleware/auth.js';

export const idParamSchema = z.object({ id: z.uuid() });

export const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

export const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

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
  // Reads are project-visible: any effective role (incl. viewer) may see the
  // session. Mutating callers must additionally gate via assertProjectRole.
  if (!access.role) throw forbidden('not a project member');
  return { session, access };
}

/**
 * Session load + role gate for handlers that historically inlined
 * `loadProjectAccess` + `assertProjectRole` (no `!access.role` pre-check) —
 * a non-member gets assertProjectRole's "requires project <min> access"
 * message, NOT ensureSessionMember's "not a project member".
 */
export async function ensureSessionRole(
  sessionId: string,
  userId: string,
  min: ProjectMemberRole,
  message?: string,
) {
  const session = await loadSessionOr404(sessionId);
  const access = await loadProjectAccess(session.projectId, userId);
  assertProjectRole(access, min, message);
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
  if (session.userId && session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
    throw forbidden('not the session owner');
  }
}

/**
 * Full mutate guard used by /send, /abort, /cancel and DELETE: member-role
 * gate + session-owner-or-admin check on a freshly loaded session row.
 */
export async function ensureSessionOwnerOrAdmin(sessionId: string, userId: string) {
  const { session, access } = await ensureSessionRole(sessionId, userId, 'member');
  assertSessionOwnerOrAdmin(session, access, userId);
  return { session, access };
}

// ISS-522 — interactive `agent` chats are private to their owner (or a project
// admin). This is a NO-OP for pipeline/pm/no-type sessions, which stay
// project-shared. Legacy `userId = NULL` agent rows are treated as non-owner →
// only an admin can read them, so they never leak to other members. Mirrors the
// owner-or-admin guard already used by the editTurn (PATCH /:id/turns/:turnId)
// route.
export function assertAgentChatOwner(
  session: { metadata: unknown; userId: string | null },
  access: Awaited<ReturnType<typeof loadProjectAccess>>,
  userId: string,
) {
  const isAgentChat = (session.metadata as { type?: string } | null)?.type === 'agent';
  if (!isAgentChat) return;
  if (session.userId !== userId && !projectRoleAtLeast(access.role, 'admin')) {
    throw forbidden('not the conversation owner');
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
