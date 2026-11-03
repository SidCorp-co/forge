/**
 * Who may finish GitHub's two returns (REQ-12 BC-20, ISS-824). Both are browser redirects, so a
 * caller they cannot serve is answered by the stranded page naming why, never by a refusal: each
 * rule returns that reason, or null where the caller may go on, and the route redirects.
 */

import type { GitHubConnectStrand } from '@forge/contracts/integrations';
import type { ConnectStateRead } from '../integrations/github/index.js';
import { isPlatformAdmin } from '../middleware/require-admin.js';
import { actorFor, can, orgResource, projectResource } from '../permissions/index.js';

type StateRead = ConnectStateRead;

/** The signed state is genuine and names this caller; the reason it is not, or null. */
function stateOwnerStrand(userId: string, read: StateRead): GitHubConnectStrand | null {
  if (!read.ok && read.why === 'invalid') return 'state_invalid';
  if (read.state.userId !== userId) return 'state_other_user';
  return null;
}

/**
 * The manifest's return: the person the signed state names, while it is fresh, and a Forge
 * operator, since it makes the instance's one App. Only `state_invalid` and `state_other_user` come
 * before the caller is proven, so only they may not spend the code to name the App they strand.
 */
export async function manifestCallbackStrand(
  userId: string,
  read: StateRead,
): Promise<GitHubConnectStrand | null> {
  const owner = stateOwnerStrand(userId, read);
  if (owner) return owner;
  if (!read.ok) return 'state_expired';
  if (!(await isPlatformAdmin(userId))) return 'not_operator';
  return null;
}

/** Whether a manifest strand was reached by a proven caller, so the code may name the App. */
export function strandMayNameApp(strand: GitHubConnectStrand): boolean {
  return strand !== 'state_invalid' && strand !== 'state_other_user';
}

/**
 * The install's return: the person the signed state names (a return with no state names nobody),
 * and, for what it records, org.admin on the state's organization (a proven install) or
 * project.admin on the project it lands on. Asked once with no `admin` for the state, and again
 * with it once the route knows where the install lands.
 */
export async function installCallbackStrand(
  userId: string,
  read: StateRead | null,
  admin?: { orgId: string } | { projectId: string },
): Promise<GitHubConnectStrand | null> {
  const owner = read ? stateOwnerStrand(userId, read) : null;
  if (owner) return owner;
  if (!admin) return null;
  const allowed =
    'orgId' in admin
      ? await can(actorFor(userId), 'org.admin', orgResource(admin.orgId))
      : await can(actorFor(userId), 'project.admin', projectResource(admin.projectId));
  return allowed ? null : 'not_admin';
}
