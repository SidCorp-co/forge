import { and, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../lib/env.js';
import { type AuthVars, authUserRow, readAuthUser } from './auth.js';
import { declareGate } from './declared-gate.js';

export function parseAdminList(): string[] {
  const raw = env.ADMIN_EMAILS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Whether this address is on the allow-list, as every reader of it asks. */
export function onAdminList(email: string): boolean {
  return parseAdminList().includes(email.toLowerCase());
}

/**
 * The allow-list read, as an answer rather than a throw, for a caller with no
 * HTTP response to throw into — the WS `canSubscribe` gate.
 *
 * A user id that resolves to no row answers `false`: outside a request there
 * is no session to invalidate, and "not an admin" is the safe reading. An
 * unverified address answers `false`, as the REST admin doors refuse it.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const row = await readAuthUser(userId);
  return row !== null && row.emailVerifiedAt !== null && onAdminList(row.email);
}

/**
 * The platform admins by the name each goes by, or their address where they set none: who a person
 * is told to ask for what only an operator of this Forge may do.
 */
export async function platformAdminNames(): Promise<string[]> {
  const allowed = parseAdminList();
  if (allowed.length === 0) return [];
  const rows = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(and(inArray(sql`lower(${users.email})`, allowed), isNotNull(users.emailVerifiedAt)))
    .orderBy(users.email);
  return rows.map((r) => r.displayName?.trim() || r.email);
}

export async function assertPlatformAdmin(c: Context<{ Variables: AuthVars }>): Promise<void> {
  const row = await authUserRow(c, c.get('userId'));
  if (row === null) {
    throw new HTTPException(401, {
      message: 'user not found',
      cause: { code: 'UNAUTHENTICATED' },
    });
  }
  if (!onAdminList(row.email)) {
    throw new HTTPException(403, {
      message: 'admin access required',
      cause: { code: 'ADMIN_ONLY' },
    });
  }
}

export function requireAdmin(): MiddlewareHandler<{ Variables: AuthVars }> {
  return declareGate('requireAdmin', async (c, next) => {
    await assertPlatformAdmin(c);
    await next();
  });
}
