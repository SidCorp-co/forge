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
    // cm:guard `human` is the fixture default because most suites assert ordinary member behaviour, and a suite that means an AGENT must say so — `agency` is what the ISS-786/812 evidence gates read, so a fixture defaulting to `agent` would silently put every unrelated suite behind those gates, and one defaulting the other way in the SOURCE is the hole `authenticatePat`'s guard describes. Fixture and source default oppositely on purpose.
    agency: 'human',
    userId,
    tokenId,
    scopes: ['read', 'write'],
    projectIds: null,
    boundProjectId: null,
    machine: null,
    ...overrides,
  };
}

/** A machine principal — the `job:<id>` credential a dispatched agent holds. */
export function makeFakeJobPrincipal(tokenId: string, userId: string, jobId: string): McpPrincipal {
  return makeFakePrincipal(tokenId, userId, {
    agency: 'agent',
    machine: { kind: 'job', id: jobId },
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
