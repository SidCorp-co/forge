import { and, inArray, not, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, issues } from '../db/schema.js';
import { holdsOpenHumanQuestion } from '../questions/issue-coupling.js';
import { issueArchiveSide } from './archive.js';
import {
  QUESTION_LIFTED_STATUSES,
  statusesInWorkState,
  type WorkState,
  type WorkStateRow,
} from './work-state.js';

export interface ProjectWorkStateRow extends WorkStateRow {
  projectId: string;
}

/**
 * The one read every count of work comes from: how many issues sit at each status, split by
 * whether a person owes one an answer, per project. The question is read once per issue as an
 * expression the rows are grouped on, so a status is never counted twice. An archived issue is
 * out of the count unless the caller asked for archived rows, as in every other discovery read.
 */
export async function readWorkStateRows(
  where: SQL | undefined,
  includeArchived: boolean,
): Promise<ProjectWorkStateRow[]> {
  const owesAnswer = holdsOpenHumanQuestion(issues.id);
  const grouped = await db
    .select({
      projectId: issues.projectId,
      status: issues.status,
      owesAnswer: sql<boolean>`${owesAnswer}`,
      n: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(and(where, ...issueArchiveSide(includeArchived)))
    .groupBy(issues.projectId, issues.status, owesAnswer);
  return grouped.map((r) => ({ ...r, owesAnswer: r.owesAnswer === true, n: Number(r.n) }));
}

/** The rows `workStateOf` files under `state`: the lifted statuses read their own state only while no question is owed. */
export function workStateCondition(state: WorkState): SQL {
  const own = statusesInWorkState(state);
  const owed = holdsOpenHumanQuestion(issues.id);
  const isLifted = (s: IssueStatus) => QUESTION_LIFTED_STATUSES.includes(s);
  const stable = own.filter((s) => !isLifted(s));
  const liftable = own.filter(isLifted);
  const parts: SQL[] = [];
  if (stable.length > 0) parts.push(inArray(issues.status, stable));
  if (liftable.length > 0) parts.push(and(inArray(issues.status, liftable), not(owed)) as SQL);
  if (state === 'blocked_on_person') {
    parts.push(and(inArray(issues.status, [...QUESTION_LIFTED_STATUSES]), owed) as SQL);
  }
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}
