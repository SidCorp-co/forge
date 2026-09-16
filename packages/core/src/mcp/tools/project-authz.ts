/**
 * The project-role gate every MCP tool passes through.
 *
 * `lib.ts` carried these next to the schema plumbing and the principal gates
 * until it reached seven modules and archmap's `no-coordinator-blob` said so.
 * The three files it split into each own one question: who is this (here),
 * which project is this (`project-scope.ts`), and what shape does the tool
 * take (`lib.ts`).
 */

import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { PM_ACTIONS } from './pm-actions.js';

/**
 * Effective-role lookup behind the principal gates in `lib.ts`. Returns `null`
 * when the project does not exist. `isMember` = any effective role (viewer
 * counts — use for READ tools); `isWriter` = member or admin (use for
 * mutating tools — viewer is read-only); `isAdmin` = effective project admin
 * (explicit row OR org owner/admin — lib/authz.ts).
 */
export async function loadUserProjectRoleFlags(
  userId: string,
  projectId: string,
): Promise<{ isMember: boolean; isWriter: boolean; isAdmin: boolean } | null> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access) return null;
  return {
    isMember: access.role !== null,
    isWriter: projectRoleAtLeast(access.role, 'member'),
    isAdmin: projectRoleAtLeast(access.role, 'admin'),
  };
}

const patReachablePmActions = PM_ACTIONS.filter((a) => a !== 'dispatch' && a !== 'write_decision');

/**
 * Gate for the two `forge_project_pm` actions that act on runner state (Epic
 * 3, ISS-19): `dispatch` and `write_decision`. They need a `runners` row whose
 * `capabilities.pm` is `true` — the explicit opt-in that lets one `claude-code`
 * runner be the PM agent for a project — and that row is keyed on a paired
 * device's id.
 *
 * Since ISS-931 no device authenticates `/mcp`, so this refuses every caller
 * that reaches it. It refuses BY NAME rather than falling back, and the
 * message says what a caller can do instead.
 */
export async function assertPmActor(principal: McpPrincipal): Promise<void> {
  throw new Error(
    'FORBIDDEN: PM_REQUIRES_DEVICE — this action acts on runner state (a `runners` row ' +
      'with capabilities.pm=true, keyed on a paired device) and /mcp no longer ' +
      'authenticates a device token at all, so it is not reachable over MCP. ' +
      `These forge_project_pm actions do work here: ${patReachablePmActions.join(', ')}. ` +
      'To set or retract a blocks/relates edge, use forge_issues create/update with ' +
      'data.relations (retract by re-sending the same edge with validUntil in the past), ' +
      'and read edges back from forge_issues get. ' +
      `Caller: ${principal.deviceId ? 'a credential issued to a box' : 'personal access token'}.`,
  );
}
