import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { PM_ACTIONS } from './pm-actions.js';

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
