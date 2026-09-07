/**
 * What an Agent Access Token's principal is made of (ISS-932).
 *
 * An agent is a `users` row wearing `kind:'agent'`, a member of one org and
 * one project. Its credential is a `personal_access_tokens` row minted by the
 * same `mintPat` a person's PAT comes from — same table, same middleware, and
 * a permission path that does not differ by a line, because the authorization
 * it gets is the membership it holds.
 *
 * This module owns the two things that are NOT shared with a person: the
 * address an agent cannot receive mail at, and the refusal that keeps it out
 * of every login entrance.
 */

import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';

/**
 * RFC 2606 reserves `.invalid` precisely so a synthesized address can never
 * resolve. `users.email` is NOT NULL UNIQUE and an agent needs one; this is
 * how it gets a value that no MX will ever accept and no person can claim.
 */
// cm:guard the domain must stay a reserved-invalid one. `users.email` is the join key every invitation, reset and OAuth-link path matches on, so an agent addressed at a domain somebody could receive mail at is an account takeover with the paperwork already filed.
export const AGENT_EMAIL_DOMAIN = 'agents.forge.invalid';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isAgentHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/**
 * The address for a new agent. The random suffix is what makes a second agent
 * called `master` in another org possible without colliding on the unique
 * index.
 */
export function synthesizeAgentEmail(handle: string): string {
  return `${handle}.${randomBytes(6).toString('hex')}@${AGENT_EMAIL_DOMAIN}`;
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

/**
 * Refuse a login for an agent principal.
 *
 * Every entrance that mints a user JWT calls this first — `auth/login.ts`,
 * `auth/refresh.ts` and `auth/oauth/handler.ts`. It takes the kind rather than
 * a user id because all three have the row in hand already.
 */
// cm:guard the check is `=== 'agent'`, never `!== 'human'`, and the asymmetry is deliberate: `users.kind` is a text column with a default, so an unknown value arriving from a future migration would lock every human out under the negative form while the positive one fails open only for a kind that does not exist yet. What must never pass is the one value that does.
export function assertNotAgent(kind: string | null | undefined, userId: string): void {
  if (kind === 'agent') throw agentCannotLogin(userId);
}
