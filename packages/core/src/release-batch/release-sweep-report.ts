// What the release sweep says about the rows it could not release: a comment on a row a failed cut
// claimed anyway, and the log lines naming each criterion that holds a row back.

import { inArray } from 'drizzle-orm';
import { postIssueNoticeOnce } from '../comments/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { IssueCriteriaReport } from '../issues/index.js';
import { logger } from '../observability/logger.js';
import { RELEASE_GATE_STATUS } from './gate.js';
import { servingClause, whyUncorroborated } from './serving-reading.js';

// `createReleaseBatch` claims issues and marks their release step in separate statements
// AFTER its own transaction, so a failure past that point (an enqueue error, say) can leave an
// issue claimed even though the attempt overall threw. An untouched row gets a hold
// (`cutFailedHold`); a claimed one is off the gate, so it is told here instead.
function claimedFailureBody(message: string, releaseBatchRunId: string | null): string {
  return [
    '**An automatic release attempt failed.**',
    '',
    `This issue was named in an automatic release sweep (ISS-1117) and the attempt did not go ` +
      `through: ${message}`,
    '',
    `This issue was already claimed into run ${releaseBatchRunId ?? '(unknown)'} before ` +
      'the attempt failed, so it will not be picked up again by this sweep — its status and ' +
      'claim need a person to look at them.',
  ].join('\n');
}

/** The rows a failed attempt claimed anyway, each told once per distinct message. */
export async function reportClaimedFailure(
  issueIds: string[],
  authorId: string,
  message: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: issues.id, status: issues.status, releaseBatchRunId: issues.releaseBatchRunId })
    .from(issues)
    .where(inArray(issues.id, issueIds));
  const claimed = rows.filter(
    (r) => !(r.status === RELEASE_GATE_STATUS && r.releaseBatchRunId === null),
  );
  for (const row of claimed) {
    const body = claimedFailureBody(message, row.releaseBatchRunId);
    try {
      await postIssueNoticeOnce({ issueId: row.id, authorId, body, marker: body });
    } catch (err) {
      logger.error({ err, issueId: row.id }, 'release-sweep: failed to post the failure comment');
    }
  }
  return claimed.map((r) => r.id);
}

/**
 * Every criterion holding an issue back, by number and by reason.
 *
 * A count says how many issues were left alone and names neither them nor what they owe, so an
 * issue that drops back a rung with no reason named is the same silence read from the other side.
 */
export function reportHeldBack(projectId: string, held: readonly IssueCriteriaReport[]): void {
  for (const report of held) {
    // Each reason says how its verdict resolved; the reading they were weighed against is said
    // once, beside them (ISS-1346).
    const reading =
      report.serving.kind === 'serving'
        ? `it is serving ${servingClause(report.serving)}`
        : whyUncorroborated(report.serving);
    const numbers = report.unearned.map((c) => c.criterion).join(', ');
    const reasons = report.unearned.map((c) => `${c.criterion}: ${c.why}`).join('; ');
    logger.info(
      {
        projectId,
        issueId: report.issueId,
        serving: report.serving,
        criteria: report.unearned.map((c) => ({
          criterion: c.criterion,
          verdict: c.verdict,
          standing: c.standing,
          why: c.why,
        })),
      },
      `release-sweep: ${report.issueId} is held back on criterion ${numbers} — ${reasons}; ${reading}`,
    );
  }
}

/** An issue cut on a runtime nothing could re-read leaves that on the record, not only the cut. */
export function reportUncorroborated(
  projectId: string,
  reports: readonly IssueCriteriaReport[],
): void {
  for (const report of reports) {
    if (report.uncorroborated.length === 0) continue;
    const why = whyUncorroborated(report.serving);
    logger.warn(
      { projectId, issueId: report.issueId, criteria: report.uncorroborated, why },
      `release-sweep: ${report.issueId} earned criterion ${report.uncorroborated.join(', ')} at a ` +
        `runtime nothing here could re-read — ${why} The verdict counts, and it is weaker ` +
        'evidence than a reading would have made it; whether this issue ships is its own criteria',
    );
  }
}
