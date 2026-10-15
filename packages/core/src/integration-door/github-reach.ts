/**
 * What a caller reaches of the instance's GitHub App: the projects they administer, the orgs those
 * sit in, and the installations recorded for those orgs or already bound in those projects. Asked
 * of can() and of the recorded installations, never of GitHub's own list of the App's installations.
 */

import { installationsReachableBy } from '../integrations/github/index.js';
import { listBindingsForProject } from '../integrations/index.js';
import { loadVisibleProjectIds, projectOrgOf } from '../lib/authz.js';
import { actorFor, can, projectResource } from '../permissions/index.js';
import { readDeclaredSource } from '../project-config/index.js';
import { listProjectHeads } from '../projects/index.js';
import { type RepositoryTarget, suggestTargets, type TargetSuggestion } from './target-suggestions.js';

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

/**
 * What each project the caller administers is offered pre-ticked among these targets. A project
 * that already has a live GitHub binding is offered nothing: it has its repository.
 */
export async function suggestionsFor(
  userId: string,
  targets: readonly RepositoryTarget[],
): Promise<TargetSuggestion[]> {
  const administered = await projectsAdministeredBy(userId);
  if (administered.length === 0 || targets.length === 0) return [];
  const unbound: string[] = [];
  for (const id of administered) {
    const pairs = await listBindingsForProject(id);
    if (!pairs.some((p) => p.binding.provider === 'github' && p.binding.active)) unbound.push(id);
  }
  if (unbound.length === 0) return [];
  const heads = await listProjectHeads(unbound);
  const projects = await Promise.all(
    heads.map(async (h) => ({ ...h, repository: (await readDeclaredSource(h.id)).repository })),
  );
  return suggestTargets(projects, targets);
}
