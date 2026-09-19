import { randomBytes } from 'node:crypto';
import { HTTPException } from 'hono/http-exception';

export const AGENT_EMAIL_DOMAIN = 'agents.forge.invalid';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isAgentHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

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

export function assertNotAgent(kind: string | null | undefined, userId: string): void {
  if (kind === 'agent') throw agentCannotLogin(userId);
}
