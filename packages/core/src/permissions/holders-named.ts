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

/** Whether an agent's account is someone a wait on this permission may name: approval is a permission, so an agent holding it counts. */
const AGENTS_NAMED: ReadonlySet<ProjectPermission> = new Set(['releases.approve']);

type ProjectHolders = Record<ProjectPermission, NamedHolder[]>;

// one read a request shares: a page's read models each name holders of the same project, and each
// asking again was four round trips a project
function projectHolders(projectId: string): Promise<ProjectHolders> {
  return memoizedRead(`namedHolders:${projectId}`, async () => {
    const byPermission = await holdersOfEach(projectId);
    const people = await peopleOf(Object.values(byPermission).flat());
    const named = (permission: ProjectPermission, ids: readonly string[]): NamedHolder[] =>
      ids
        .flatMap((id) => {
          const p = people.get(id);
          return p && (AGENTS_NAMED.has(permission) || p.kind !== 'agent') ? [{ id, ...p }] : [];
        })
        .sort(
          (a, b) =>
            Number(a.kind === 'agent') - Number(b.kind === 'agent') || a.name.localeCompare(b.name),
        );
    return Object.fromEntries(
      Object.entries(byPermission).map(([permission, ids]) => [
        permission,
        named(permission as ProjectPermission, ids),
      ]),
    ) as ProjectHolders;
  });
}

/**
 * Who holds `permission` on one project, people by name first and then agents where the permission
 * counts them. A person's write or admin act is one an agent's account does not take for them, so
 * those name people only.
 */
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
