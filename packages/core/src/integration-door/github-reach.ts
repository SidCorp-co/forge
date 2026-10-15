/**
 * What a caller reaches of the instance's GitHub App: the projects they administer, the orgs those
 * sit in, and the installations recorded for those orgs or already bound in those projects. Asked
 * of can() and of the recorded installations, never of GitHub's own list of the App's installations.
 */

import { installationsReachableBy } from '../integrations/github/index.js';
import { loadVisibleProjectIds, projectOrgOf } from '../lib/authz.js';
import { actorFor, can, projectResource } from '../permissions/index.js';

/** The projects the caller may administer, asked of can() one by one. */
export async function projectsAdministeredBy(userId: string): Promise<string[]> {
  const actor = actorFor(userId);
  const visible = await loadVisibleProjectIds(userId);
  const held = await Promise.all(
    visible.map((id) => can(actor, 'project.admin', projectResource(id))),
  );
  return visible.filter((_, i) => held[i]);
}

/** The installations of the instance App the caller may list and bind from. */
export async function instanceInstallationsFor(
  userId: string,
  connectionId: string,
): Promise<Array<{ id: number; account: string }>> {
  const administeredProjectIds = await projectsAdministeredBy(userId);
  const orgs = await Promise.all(administeredProjectIds.map((id) => projectOrgOf(id)));
  const orgIds = [...new Set(orgs.filter((o): o is string => o !== null))];
  return installationsReachableBy({ connectionId, orgIds, administeredProjectIds });
}
