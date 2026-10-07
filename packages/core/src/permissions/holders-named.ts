import type { ProjectPermission } from '@forge/contracts/permissions';
import { peopleOf } from '../lib/people.js';
import { holdersOf } from './can.js';

// Who a wait on a permission names: the holders `holdersOf` finds, by name. The words they are said
// in are `@forge/contracts/standing:holdersWho` and `:nobodyHoldsAct`.

/** One holder of a permission on a project, as a wait names them. */
export interface NamedHolder {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

/** Whether an agent's account is someone a wait on this permission may name: approval is a permission, so an agent holding it counts. */
const AGENTS_NAMED: ReadonlySet<ProjectPermission> = new Set(['releases.approve']);

/**
 * Who holds `permission` on each project, people by name first and then agents where the
 * permission counts them; every project asked for is a key. A person's write or admin act is one an
 * agent's account does not take for them, so those name people only.
 */
export async function namedHoldersOf(
  permission: ProjectPermission,
  projectIds: readonly string[],
): Promise<Map<string, NamedHolder[]>> {
  const byProject = await holdersOf(permission, projectIds);
  const people = await peopleOf([...byProject.values()].flat());
  const agents = AGENTS_NAMED.has(permission);
  return new Map(
    [...byProject].map(([projectId, ids]) => [
      projectId,
      ids
        .flatMap((id) => {
          const p = people.get(id);
          return p && (agents || p.kind !== 'agent') ? [{ id, ...p }] : [];
        })
        .sort(
          (a, b) =>
            Number(a.kind === 'agent') - Number(b.kind === 'agent') || a.name.localeCompare(b.name),
        ),
    ]),
  );
}

/** The holders of one project's `permission`; see `namedHoldersOf`. */
export async function namedHolders(
  permission: ProjectPermission,
  projectId: string,
): Promise<NamedHolder[]> {
  return (await namedHoldersOf(permission, [projectId])).get(projectId) ?? [];
}

/** The names of one project's holders of `permission`, in the order a wait names them. */
export async function holderNames(
  permission: ProjectPermission,
  projectId: string,
): Promise<string[]> {
  return (await namedHolders(permission, projectId)).map((h) => h.name);
}
