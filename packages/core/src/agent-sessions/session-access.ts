import { eq, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, type ProjectMemberRole } from '../db/schema.js';
import {
  assertProjectRole,
  assertRoleFor,
  loadProjectAccess,
  projectRoleAtLeast,
} from '../lib/authz.js';
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

export const DEVICE_SPEAKS_FOR_NO_PERSON =
  "A paired box's device token reaches only the sessions dispatched to its box, and this route acts for a person. " +
  'Send a personal access token, or sign in.';

/** The person a session route acts for; a device, which names none, is refused in those words. */
/** A box lists the sessions dispatched to it, as `GET /:id` reads one of them, and no other box's. */
export function boxSessionFilter(
  own: string | undefined,
  asked?: string,
  projectId?: string,
): SQL[] {
  if (!own || (asked && asked !== own)) {
    throw forbidden('A box lists only the sessions dispatched to it.');
  }
  const on = [eq(agentSessions.deviceId, own)];
  if (projectId) on.push(eq(agentSessions.projectId, projectId));
  return on;
}

export function personOrRefuse(userId: string | undefined): string {
  if (!userId) throw forbidden(DEVICE_SPEAKS_FOR_NO_PERSON);
  return userId;
}

export async function ensureSessionMember(sessionId: string, userId: string) {
  personOrRefuse(userId);
  const session = await loadSessionOr404(sessionId);
  const access = await loadProjectAccess(session.projectId, userId);
  // Reads are project-visible: any effective role (incl. viewer) may see the
  // session. Mutating callers must additionally gate via assertRoleFor.
  if (!access.role) throw forbidden('not a project member');
  return { session, access };
}

/**
 * `act` is optional only for the calls in lifecycle-routes.ts, which ISS-1236 r2 holds; those still
 * refuse in role words until that file names its acts (ISS-1421 r31).
 */
export async function ensureSessionRole(
  sessionId: string,
  userId: string,
  min: ProjectMemberRole,
  act?: string,
) {
  personOrRefuse(userId);
  const session = await loadSessionOr404(sessionId);
  const access = await loadProjectAccess(session.projectId, userId);
  if (act) assertRoleFor(access, min, act);
  else assertProjectRole(access, min);
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
export async function ensureSessionOwnerOrAdmin(sessionId: string, userId: string, act?: string) {
  const { session, access } = await ensureSessionRole(sessionId, userId, 'member', act);
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
