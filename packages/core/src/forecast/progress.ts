import type { IssueProgress } from '@forge/contracts/forecast';
import type { IssueStatus } from '@forge/contracts/issue-machine';

/**
 * A scope's issues by how far each has got (`IssueProgress`): the one count of shipped, landed and to
 * do. Shipped is what a release record says shipped (`released`), never `closed`, which says only
 * that an issue's criteria were met in scope; an issue landed or closed that no release carries yet
 * waits for its release.
 */
export function issueProgressOf<R extends { status: IssueStatus | string }>(
  rows: readonly R[],
  released: (row: R) => boolean,
): IssueProgress {
  const live = rows.filter((r) => r.status !== 'dropped');
  const shipped = live.filter(released).length;
  const awaitingRelease = live.filter(
    (r) => !released(r) && (r.status === 'awaiting_release' || r.status === 'closed'),
  ).length;
  return {
    total: live.length,
    shipped,
    awaitingRelease,
    toDo: live.length - shipped - awaitingRelease,
  };
}
