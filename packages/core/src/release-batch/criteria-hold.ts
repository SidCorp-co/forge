import { unearnedCriteriaReports } from '../issues/criteria-verdicts.js';
import { projectAutoProdDeploy } from '../pipeline/auto-prod-deploy.js';
import { blocker, evaluate } from './blocker-kit.js';
import {
  type HeldIssueRef,
  heldBackWarningSentence,
  RELEASE_ROSTER_LIMIT,
  type ReleaseBlocker,
  type ReleaseWarning,
} from './blocker-sentences.js';

/**
 * The reason the unattended sweep will not carry these issues, which reached
 * `logger.info` and no surface at all before ISS-1127. It mirrors
 * `sweepProject`: that function returns early only where NOTHING is left
 * eligible, so all-held blocks and partly-held warns. Roster-scoped.
 */
export async function criteriaHold(
  projectId: string,
  waiting: string[],
  out: ReleaseBlocker[],
  warnings: ReleaseWarning[],
): Promise<void> {
  // The roster limit bounds the per-issue comment reads below; above it
  // `RELEASE_ROSTER_OVERSIZE` is already the reason standing.
  if (waiting.length === 0 || waiting.length > RELEASE_ROSTER_LIMIT) return;
  const auto = await evaluate(
    'auto-release',
    async () => await projectAutoProdDeploy(projectId),
    out,
  );
  if (auto !== true) return;
  const reports = await evaluate(
    'criteria',
    async () => await unearnedCriteriaReports(waiting),
    out,
  );
  if (!reports) return;
  const held: HeldIssueRef[] = reports
    .filter((r) => r.unearned.length > 0)
    .map((r) => ({ issueId: r.issueId, criteria: r.unearned.map((c) => c.criterion) }));
  if (held.length === 0) return;
  if (held.length === waiting.length) {
    out.push(blocker('RELEASE_CRITERIA_UNEARNED', { held }, 'roster'));
    return;
  }
  warnings.push({
    code: 'RELEASE_CRITERIA_HELD_BACK',
    message: heldBackWarningSentence(held),
    details: { held },
  });
}
