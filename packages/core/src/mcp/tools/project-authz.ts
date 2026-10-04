import { effectiveProjectRole, projectRoleAtLeast } from '../../lib/authz.js';
import type { McpPrincipal } from '../../middleware/require-pat.js';

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
