import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';

export const AGENT_EMAIL_DOMAIN = 'agents.forge.invalid';

/** Forge's own account's address: the account its sweeps write as, a member of nothing. */
export const FORGE_ADDRESS = `forge@${AGENT_EMAIL_DOMAIN}`;

/** An address only Forge mints, for an agent account; no person signs up or signs in with one. */
export function isAgentAddress(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`);
}

export function isForgeAddress(email: string): boolean {
  return email.trim().toLowerCase() === FORGE_ADDRESS;
}

export const AGENT_ADDRESS_RESERVED =
  'That address belongs to an agent account Forge runs, and no person signs up or signs in with it. ' +
  'Use an address you receive mail at.';

export function agentAddressReserved(email: string): HTTPException {
  return new HTTPException(409, {
    message: AGENT_ADDRESS_RESERVED,
    cause: { code: 'AGENT_ADDRESS_RESERVED', details: { email } },
  });
}

/** What every door that adds a person answers an agent address or account with: no person can
 *  accept an invitation there, and an agent's projects are set on the agent itself
 *  (`orgs/agent-accounts.ts`), never through a person's door (ISS-1421 round 3). */
export function agentIsNotAPerson(named: { email: string } | { userId: string }): HTTPException {
  const what =
    'email' in named
      ? `${named.email} is an address Forge mints for an agent account, not a person's.`
      : `Account ${named.userId} is an agent account Forge mints, not a person.`;
  return new HTTPException(409, {
    message: `${what} No person can be invited or added as it. An agent account is given its projects under Settings → Agents.`,
    cause: { code: 'AGENT_ADDRESS_RESERVED', details: named },
  });
}

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
  'This account is an agent and cannot sign in. An agent authenticates with its ' +
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
