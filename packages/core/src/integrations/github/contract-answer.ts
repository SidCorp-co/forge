import { eq } from 'drizzle-orm';
import { type Db, db } from '../../db/client.js';
import { type IssueStatus, issues } from '../../db/schema.js';
import { readEntryCriteriaStrict } from '../../issues/entry-criteria.js';
import type { EntryCriterionKey } from '../../issues/entry-criteria-keys.js';

/** The contract this check reads, named in its own body so nothing mistakes it for another. */
export const CONTRACT_SOURCE =
  "this project's declared status entry criteria (pipelineConfig.statusEntryCriteria)";

export type ContractAnswer =
  | {
      kind: 'judged';
      status: IssueStatus;
      declared: EntryCriterionKey[];
      met: EntryCriterionKey[];
      unmet: { key: EntryCriterionKey; detail: string }[];
      computedAt: Date;
    }
  | { kind: 'none-declared'; status: IssueStatus; computedAt: Date }
  | { kind: 'unreadable'; status: IssueStatus | null; reason: string; computedAt: Date };

/** The status and project of one issue, or null where the row is gone. */
async function issueStanding(
  issueId: string,
  executor: Pick<Db, 'select'>,
): Promise<{ status: IssueStatus; projectId: string } | null> {
  const [row] = await executor
    .select({ status: issues.status, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ?? null;
}

/**
 * The contract's answer for this issue, as of now.
 *
 * `computedAt` is on every arm and is rendered on every body: the answer moves
 * with events, and one input — a `blocks` work-evidence waiver whose
 * `valid_until` passes — moves with nothing at all. ISS-1072 forbids polling, so
 * the only honest thing the check can do about that input is say when it looked.
 */
export async function contractAnswerForIssue(
  issueId: string,
  executor: Pick<Db, 'select'> = db,
): Promise<ContractAnswer> {
  const computedAt = new Date();
  let status: IssueStatus | null = null;
  try {
    const standing = await issueStanding(issueId, executor);
    if (!standing) {
      return { kind: 'unreadable', status: null, reason: 'no issue row was found', computedAt };
    }
    status = standing.status;
    const reading = await readEntryCriteriaStrict({
      projectId: standing.projectId,
      issueId,
      status: standing.status,
      executor,
    });
    if (reading.declared.length === 0) {
      return { kind: 'none-declared', status: standing.status, computedAt };
    }
    return { kind: 'judged', status: standing.status, ...reading, computedAt };
  } catch (err) {
    return {
      kind: 'unreadable',
      status,
      reason: err instanceof Error ? err.message : String(err),
      computedAt,
    };
  }
}
