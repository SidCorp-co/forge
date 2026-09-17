/**
 * What the tracker's contract says about one issue, right now.
 *
 * ISS-1072. This is the thing the check run reports, and it is derived rather
 * than typed: the project declares which records a status entry requires
 * (`pipelineConfig.statusEntryCriteria`), `issues/entry-criteria.ts` owns what
 * each of those five keys means and what the remedy for each is, and this file
 * asks that pair about the status the issue is standing in.
 *
 * ## Which contract this is, and which it is not
 *
 * The contract read here is the one CORE enforces, against every client, from
 * every door. It is not the record ladder `forge advance --owed` answers from —
 * confirmation, decision, plan, criteria, baseline, review, merged, verdict,
 * verification, note — which lives in `github.com/SidCorp-co/forge-plugin`,
 * resolves per runner box out of a plugin cache, ships on its own release clock,
 * and appears nowhere in this package. ISS-1072 asks for the two to agree; a
 * finding on that issue records that core holds no copy of the second and that
 * this repo's own rules forbid a job here from changing the repo that does.
 *
 * That divergence is why `check-run-body.ts` makes the published body NAME the
 * contract it read. A reader who takes this answer for the ladder's has been
 * given the wrong thing, and the only defence against that is the check saying
 * which one it is.
 *
 * ## Three answers, never two
 *
 * `judged`, `none-declared` and `unreadable` are kept apart because the gate
 * they are built on collapses all three into one value: `resolveDeclaredEntryCriteria`
 * swallows a failed config read into `[]`, and `findUnmetEntryCriteria` returns
 * `null` for "nothing declared" and for "all met" alike. That is right for a
 * gate that must not freeze a project's tracker and wrong for a report published
 * on a pull request, where "the project asks nothing here" and "I could not find
 * out what the project asks" must not read the same.
 */

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
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
): Promise<{ status: IssueStatus; projectId: string } | null> {
  const [row] = await db
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
// cm:guard this function does not throw. Every failure becomes an `unreadable` answer, because the caller is mid-publish to GitHub and a throw there costs the check run rather than the criterion — and a missing check run is the silence this whole change exists to remove.
export async function contractAnswerForIssue(issueId: string): Promise<ContractAnswer> {
  const computedAt = new Date();
  let status: IssueStatus | null = null;
  try {
    const standing = await issueStanding(issueId);
    if (!standing) {
      return { kind: 'unreadable', status: null, reason: 'no issue row was found', computedAt };
    }
    status = standing.status;
    const reading = await readEntryCriteriaStrict({
      projectId: standing.projectId,
      issueId,
      status: standing.status,
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
