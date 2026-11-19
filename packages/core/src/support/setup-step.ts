// Who names the Forge account a chat account is, where a room's writer maps to none (ISS-976,
// ISS-1210, ISS-1313): a project admin of the act's project, or an instance admin once for every
// project. Every text that tells an agent a writer is unmapped names this step and its holders, and
// never asks the writer to link anything: the owner a binding names is not asked to set anything up.

import { holderNames } from '../permissions/index.js';

/**
 * `a project admin (Ann, Ben) names their Forge account (POST …), or an instance admin once for every
 * project (POST /api/speaker-links/named)`: the setup step and who holds it, for `whose` account.
 */
export async function namingStep(projectId: string, whose: string): Promise<string> {
  const names = await holderNames('project.admin', projectId);
  const admins = names.length > 0 ? `a project admin (${names.join(', ')})` : 'a project admin';
  return `${admins} names ${whose} Forge account (POST /api/projects/${projectId}/speaker-links/named), or an instance admin once for every project (POST /api/speaker-links/named)`;
}
