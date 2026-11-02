import type { ProjectPermission } from '@forge/contracts/permissions';
import { memoizedRead } from '../db/read-memo.js';
import { peopleOf } from '../lib/people.js';
import { holdersOfEach } from './can.js';

// Who a wait on a permission names: the holders `can.ts:holdersOfEach` finds, by name. The words
// they are said in are `@forge/contracts/standing:holdersWho` and `:nobodyHoldsAct`.

/** One holder of a permission on a project, as a wait names them. */
export interface NamedHolder {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

type ProjectHolders = Record<ProjectPermission, NamedHolder[]>;

// A wait on a permission names the people who hold it, never an agent's account: an agent's role can
// hold an approval (an admin role holds every one), but a wait names whom it waits on, and a release
// listing its own agent as its approver waits on nobody who will approve it (ISS-869).

// one read a request shares: a page's read models each name holders of the same project, and each
// asking again was four round trips a project
function projectHolders(projectId: string): Promise<ProjectHolders> {
  return memoizedRead(`namedHolders:${projectId}`, async () => {
    const byPermission = await holdersOfEach(projectId);
    const people = await peopleOf(Object.values(byPermission).flat());
    const named = (ids: readonly string[]): NamedHolder[] =>
      ids
        .flatMap((id) => {
          const p = people.get(id);
          return p && p.kind !== 'agent' ? [{ id, ...p }] : [];
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    return Object.fromEntries(
      Object.entries(byPermission).map(([permission, ids]) => [permission, named(ids)]),
    ) as ProjectHolders;
  });
}

/** Who holds `permission` on one project: the people, by name; never an agent's account. */
export async function namedHolders(
  permission: ProjectPermission,
  projectId: string,
): Promise<NamedHolder[]> {
  return (await projectHolders(projectId))[permission];
}

/** The names of one project's holders of `permission`, in the order a wait names them. */
export async function holderNames(
  permission: ProjectPermission,
  projectId: string,
): Promise<string[]> {
  return (await namedHolders(permission, projectId)).map((h) => h.name);
}
