import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { users } from '../db/schema.js';

export const AGENT_EMAIL_DOMAIN = 'agents.forge.invalid';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isAgentHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

export function synthesizeAgentEmail(handle: string): string {
  return `${handle}.${randomBytes(6).toString('hex')}@${AGENT_EMAIL_DOMAIN}`;
}

/**
 * The `users` row an agent account is minted with, wherever one is minted. Its handle is also the
 * label a reader is shown, so no renderer falls back to the synthesized address, which exists only
 * because the column is required and unique (ISS-1317).
 */
export function agentAccountRow(handle: string, id?: string) {
  return {
    ...(id ? { id } : {}),
    email: synthesizeAgentEmail(handle),
    kind: 'agent' as const,
    passwordHash: null,
    emailVerifiedAt: new Date(),
    displayName: handle,
  };
}

export const AGENT_CANNOT_LOGIN =
  'this account is an agent and cannot sign in — an agent authenticates with its ' +
  'Agent Access Token and holds no password, no session and no mailbox. An org ' +
  'admin manages it under the organization it belongs to.';

export function agentCannotLogin(userId: string): HTTPException {
  return new HTTPException(403, {
    message: AGENT_CANNOT_LOGIN,
    cause: { code: 'AGENT_CANNOT_LOGIN', details: { userId } },
  });
}

export function assertNotAgent(kind: string | null | undefined, userId: string): void {
  if (kind === 'agent') throw agentCannotLogin(userId);
}

/** The one insert of an agent account, inside the caller's transaction. */
export async function insertAgentAccount(
  tx: Tx,
  handle: string,
  id?: string,
): Promise<{ id: string; email: string; createdAt: Date }> {
  const [row] = await tx
    .insert(users)
    .values(agentAccountRow(handle, id))
    .returning({ id: users.id, email: users.email, createdAt: users.createdAt });
  if (!row) throw new Error('agent account: user insert returned no row');
  return row;
}

/** The label an agent is read by; `null` clears it. Undefined when the account is gone. */
export async function setUserDisplayName(
  userId: string,
  displayName: string | null,
): Promise<string | null | undefined> {
  const [row] = await db
    .update(users)
    .set({ displayName })
    .where(eq(users.id, userId))
    .returning({ displayName: users.displayName });
  return row ? row.displayName : undefined;
}
