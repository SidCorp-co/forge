import type { McpPrincipal } from '../middleware/require-pat.js';
import type { McpContext } from './tools/lib.js';

export function makeFakePrincipal(
  tokenId: string,
  userId: string,
  overrides: Partial<McpPrincipal> = {},
): McpPrincipal {
  return {
    kind: 'pat',
    agency: null,
    agentUserId: null,
    userId,
    tokenId,
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
    deviceId: null,
    ...overrides,
  };
}

/**
 * A machine principal — the box-issued agent credential a dispatched agent
 * holds. Its third argument names the BOX, not the job: since ISS-932 wave 4 a
 * credential names where it runs and which project it may reach, and the job is
 * resolved from the live session on that pair.
 */
export function makeFakeJobPrincipal(
  tokenId: string,
  userId: string,
  deviceId: string,
  boundProjectId: string | null = null,
): McpPrincipal {
  return makeFakePrincipal(tokenId, userId, {
    agency: 'agent',
    agentUserId: userId,
    deviceId,
    boundProjectId,
  });
}

/** The whole per-request context, for the factories that take one. */
export function makeFakeContext(
  principal: McpPrincipal,
  overrides: Partial<McpContext> = {},
): McpContext {
  return {
    principal,
    projectSlug: null,
    boundProjectId: principal.boundProjectId,
    ...overrides,
  };
}
