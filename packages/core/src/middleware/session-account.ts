import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { assertNotAgent } from '../auth/agent-account.js';
import { db } from '../db/client.js';
import { type UserKind, users } from '../db/schema.js';

/** The columns of the caller's `users` row that an auth gate decides on. */
export type AuthUserRow = { email: string; emailVerifiedAt: Date | null; kind: UserKind };

/** The caller's `users` row, unmemoised, for a caller with no request context. */
export async function readAuthUser(userId: string): Promise<AuthUserRow | null> {
  const [row] = await db
    .select({ email: users.email, emailVerifiedAt: users.emailVerifiedAt, kind: users.kind })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

const AUTH_USER_VAR = 'authUserResolution';

type AuthUserResolution = { userId: string; row: AuthUserRow | null };

export async function authUserRow(c: Context, userId: string): Promise<AuthUserRow | null> {
  const cached = c.get(AUTH_USER_VAR) as AuthUserResolution | undefined;
  if (cached && cached.userId === userId) return cached.row;

  const row = await readAuthUser(userId);
  c.set(AUTH_USER_VAR, { userId, row } satisfies AuthUserResolution);
  return row;
}

/** A session token is a person's; one naming an agent account is refused, as the token door reads the same row. */
export async function admitSessionUser(c: Context, userId: string): Promise<void> {
  assertNotAgent((await authUserRow(c, userId))?.kind, userId);
}
