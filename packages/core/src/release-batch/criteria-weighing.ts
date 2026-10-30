// forge-core-61 — one issue's criteria weighed as the gate that will decide it weighs them, for the
// criteria read (`issues/criteria-weighing.ts`). It calls the release's own weighings and no other:
// a promotion project at the landing (`criteria-basis.ts:landingCriteriaReports`), any other at what
// is served (`issues/criteria-verdicts.ts:unearnedCriteriaReports`, the judged-on environment until
// the issue is released). Where no basis can be computed, every criterion says why.

import type { CriterionWeighing, IssueCriteriaWeighing } from '../issues/index.js';
import { unearnedCriteriaReports } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { gateOf } from '../project-config/index.js';
import { type CriteriaBasis, criteriaBasisOf, landingCriteriaReports } from './criteria-basis.js';
import { READ_PATH_HELD_ONLY, readWeighingNow } from './runtime-weighing.js';
import { readServingNow } from './serving-reading.js';

const short = (sha: string) => sha.slice(0, 12);

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function atLanding(
  issue: { id: string; projectId: string },
  basis: Extract<CriteriaBasis, { kind: 'landing' }>,
): Promise<IssueCriteriaWeighing> {
  const [report] = await landingCriteriaReports(issue.projectId, [issue.id]);
  if (!report) return { kind: 'none', why: 'the landing weighing returned nothing for this issue' };
  const { landsOn, deploysFrom } = basis;
  const weighedOn = { basis: 'landing', landing: report.landing, landsOn, deploysFrom } as const;
  const where = `this project's work lands on \`${landsOn}\` and production deploys \`${deploysFrom}\` through a promotion, so a criterion is earned at the landing`;
  const criteria = new Map<number, CriterionWeighing>();
  for (const { criterion, why } of report.unearned) {
    criteria.set(criterion, {
      earned: false,
      standing: null,
      reason: `${why}; ${where}`,
      weighedOn,
    });
  }
  const landing = report.landing ?? '';
  for (const { criterion, at } of report.counted) {
    const own = at === landing.toLowerCase();
    const reason = own
      ? `judged at the landing commit \`${short(at)}\` on \`${landsOn}\`, which counts there`
      : `judged at \`${short(at)}\`, a later build that holds the landing commit \`${short(landing)}\` on \`${landsOn}\`, which counts there`;
    criteria.set(criterion, {
      earned: true,
      standing: own ? 'stands' : 'carried',
      reason,
      weighedOn,
    });
  }
  return { kind: 'weighed', criteria };
}

async function atServed(issue: { id: string; projectId: string }): Promise<IssueCriteriaWeighing> {
  const serving = await readServingNow(issue.projectId);
  const weighing = await readWeighingNow(issue.projectId, serving, [issue.id], {
    heldOnly: READ_PATH_HELD_ONLY,
  });
  const [report] = await unearnedCriteriaReports([issue.id], serving, weighing);
  if (!report) return { kind: 'none', why: 'the served weighing returned nothing for this issue' };
  const criteria = new Map<number, CriterionWeighing>();
  for (const c of report.unearned) {
    const weighedOn = { basis: 'served', environment: c.environment, runtime: c.runtime } as const;
    criteria.set(c.criterion, { earned: false, standing: c.standing, reason: c.why, weighedOn });
  }
  for (const c of report.earned) {
    const weighedOn = { basis: 'served', environment: c.environment, runtime: c.runtime } as const;
    const standing = c.carried ? 'carried' : c.standing;
    criteria.set(c.criterion, { earned: true, standing, reason: c.why, weighedOn });
  }
  return { kind: 'weighed', criteria };
}

/**
 * Each live criterion of `issue` weighed where the release decides it. A read that fails is answered
 * as why nothing was weighed, never as a thrown criteria read nor as criteria with no standing.
 */
export async function criteriaWeighingOf(issue: {
  id: string;
  projectId: string;
}): Promise<IssueCriteriaWeighing> {
  try {
    // gate `release_criteria` (REQ-76): off owes no verdict, so no gate weighs them
    if ((await gateOf(issue.projectId, 'release_criteria')).mode === 'off') {
      return {
        kind: 'none',
        why: "this project's `release_criteria` gate is off, so no gate weighs its criteria before a release",
      };
    }
    const basis = await criteriaBasisOf(issue.projectId);
    if (basis.kind === 'unread') {
      return {
        kind: 'none',
        why: `where this project's criteria are earned could not be read: ${basis.why}`,
      };
    }
    return basis.kind === 'landing' ? await atLanding(issue, basis) : await atServed(issue);
  } catch (err) {
    logger.warn({ err, issueId: issue.id }, 'criteria read: the criteria could not be weighed');
    return { kind: 'none', why: `the criteria could not be weighed: ${messageOf(err)}` };
  }
}
