/**
 * The principal and context every MCP tool suite needs to call a handler.
 *
 * Thirty suites each carried their own byte-identical `Device` literal, so a
 * new `devices` column meant thirty edits and pushed two files past their
 * frozen size budget. ISS-931 took the device off `/mcp` entirely, so the same
 * fixture now hands out the one principal species there is. Excluded from the
 * build by `tsconfig.build.json`.
 */

import type { McpPrincipal } from '../middleware/require-pat.js';
import type { McpContext } from './tools/lib.js';

// cm:guard return a FRESH object per call. A shared instance is a mutable principal handed to every test in the file, so one handler that writes to it silently changes the identity the next case authenticates with.
export function makeFakePrincipal(
  tokenId: string,
  userId: string,
  overrides: Partial<McpPrincipal> = {},
): McpPrincipal {
  return {
    kind: 'pat',
    // cm:guard `null` — unestablished — is the fixture default because that is what a person's token really carries since ISS-1003, and a suite that means an AGENT must say so by handing it one. It is NOT the lenient direction: `issues/actor-agency.ts:actorAgency` maps unestablished to `agent`, so a suite that forgets meets the ISS-786/812 evidence gates rather than slipping past them, which is the way round a default has to fail.
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
