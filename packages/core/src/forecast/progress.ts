import type { IssueProgress } from '@forge/contracts/forecast';
import type { IssueStatus } from '@forge/contracts/issue-machine';

/** A scope's issues by how far each has got (`IssueProgress`): the one count of shipped, landed and to do. */
export function issueProgressOf(rows: readonly { status: IssueStatus | string }[]): IssueProgress {
  const live = rows.filter((r) => r.status !== 'dropped');
  const shipped = live.filter((r) => r.status === 'closed').length;
  const awaitingRelease = live.filter((r) => r.status === 'awaiting_release').length;
  return {
    total: live.length,
    shipped,
    awaitingRelease,
    toDo: live.length - shipped - awaitingRelease,
  };
}
