import { randomBytes } from 'node:crypto';
import type { AuthRefusalCode } from '@forge/contracts/auth';
import { type RefusalError, refuser } from '../lib/refusal.js';

const refuse = refuser<AuthRefusalCode>('AUTH_REFUSED');

const AGENT_EMAIL_DOMAIN = 'agents.forge.invalid';

const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export function isAgentHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/** A project's agent handle: its slug where that is a valid handle, else one derived from its id. */
export function handleNameForProject(slug: string, projectId: string): string {
  const derived = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return isAgentHandle(derived) ? derived : `agent-${projectId.slice(0, 8)}`;
}

function synthesizeAgentEmail(handle: string): string {
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

function agentCannotLogin(userId: string): RefusalError {
  return refuse('AGENT_CANNOT_LOGIN', `account ${userId}: ${AGENT_CANNOT_LOGIN}`);
}

export function assertNotAgent(kind: string | null | undefined, userId: string): void {
  if (kind === 'agent') throw agentCannotLogin(userId);
}
