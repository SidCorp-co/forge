// forge-core-61 — one issue's criteria weighed as the gate that will decide it weighs them, for the
// criteria read (`issues/criteria-weighing.ts`) and the steward's facts (`criteria-facts.ts`, ISS-1035:
// adminhub-api's steward called earned passes missing while the read counted them). It calls the
// release's own weighings and no other: a project with no production at the build it delivers, as its
// landing record weighs it (`landed-build.ts:deliveredBuildsOf`, `landedStandings`); a project where
// nothing it judges on serves a change before its release (a promotion, or production
// deployed only by a release: ISS-957, ISS-964) at the landing (`criteria-basis.ts:landingCriteriaReports`),
// one judging on a `delivery.judgedOn` environment at what is served
// (`issues/criteria-verdicts.ts:unearnedCriteriaReports`, that environment until the issue is released). Where no basis can be computed, every criterion says why.

import type { CriterionWeighing, IssueCriteriaWeighing } from '../issues/index.js';
import { unearnedCriteriaReports } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { gateOf } from '../project-config/index.js';
import {
  type CriteriaBasis,
  criteriaBasisOf,
  landingCriteriaReports,
  landingWhere,
} from './criteria-basis.js';
import { type Delivery, deliveredBuildsOf, deliveryOf, landedStandings } from './landed-build.js';
import { earlierCarriageOf } from './landed-build-holds.js';
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
  const where = `${landingWhere(basis)}, so a criterion is earned at the landing${basis.byRecord ? ' or on a release that holds it' : ''}`;
  const criteria = new Map<number, CriterionWeighing>();
  for (const { criterion, why, liveOnly } of report.unearned) {
    criteria.set(criterion, {
      earned: false,
      standing: null,
      reason: `${why}; ${where}`,
      weighedOn,
      ...(liveOnly ? { owedOn: 'live-release' as const } : {}),
    });
  }
  // live-only: it holds no release, and is owed on the one that carries the issue once it ships
  for (const { criterion, why } of report.afterRelease) {
    criteria.set(criterion, {
      earned: false,
      standing: null,
      reason: `${why}; it holds no release`,
      weighedOn,
      owedOn: 'after-release',
    });
  }
  const landing = report.landing ?? '';
  for (const { criterion, at, carried, release } of report.counted) {
    if (release) {
      // judged on a release, read on the project's release record (ISS-900), never at a commit
      const reason = `${carried ?? `judged on live release ${release}`}, read on this project's release record, which counts there`;
      const standing = carried ? 'carried' : 'stands';
      criteria.set(criterion, { earned: true, standing, reason, weighedOn });
      continue;
    }
    const own = at === landing.toLowerCase();
    const reason = own
      ? `judged at the landing commit \`${short(at)}\` on \`${landsOn}\`, which counts there`
      : carried
        ? `${carried}, on \`${landsOn}\`, which counts there`
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

/**
 * Each live criterion at the build a project with no production delivers, as its landing record and
 * the steward weigh it (`landedStandings`): judged at that commit, carried to it from an earlier one it
 * descends from (ISS-845), or, on an open change request, at its unchanged head.
 */
async function atDelivered(
  issue: { id: string; projectId: string },
  delivery: Delivery,
): Promise<IssueCriteriaWeighing> {
  const build = (await deliveredBuildsOf(issue.projectId, delivery, [issue.id])).get(
    issue.id.toLowerCase(),
  );
  if (!build) return { kind: 'none', why: 'the issue was not found' };
  if (build.sha === null) {
    const unread = build.unread
      ? ': whether its work is on that branch is unknown, not absent, so read it again once the host answers'
      : '';
    return { kind: 'none', why: `${build.why}${unread}` };
  }
  const sha = build.sha;
  // what the delivered build holds of each other commit its verdicts name, from Forge's records
  const builds = new Map([[issue.id.toLowerCase(), build]]);
  const [standing] = await landedStandings(
    [issue.id],
    () => sha,
    () => build.via ?? null,
    () => build.head ?? null,
    undefined,
    (judged, judgedOnFor) => earlierCarriageOf(issue.projectId, builds, judged, judgedOnFor),
  );
  if (!standing)
    return { kind: 'none', why: 'the delivered weighing returned nothing for this issue' };
  if (!standing.owes) {
    return { kind: 'none', why: "this project's document owes no verdict on its issues" };
  }
  const weighedOn = {
    basis: 'delivered',
    delivery,
    build: sha,
    from: build.from,
    said: build.basis,
  } as const;
  const criteria = new Map<number, CriterionWeighing>();
  for (const c of standing.criteria) {
    if (!c.counts) {
      const owedOn = c.afterRelease ? 'after-release' : c.liveOnly ? 'live-release' : null;
      criteria.set(c.criterion, {
        earned: false,
        standing: null,
        reason: c.why,
        weighedOn,
        ...(owedOn ? { owedOn } : {}),
      });
      continue;
    }
    const own = c.at === sha;
    const reason = c.release
      ? `${c.carried ?? `judged on live release ${c.release}`}, read on this project's release record, which counts there`
      : own
        ? `judged at \`${short(sha)}\`, the build it delivers, which counts there`
        : c.carried
          ? `${c.carried}, which counts there`
          : `judged at \`${short(c.at)}\`, the head that merged as \`${short(sha)}\` with an identical tree, which counts there`;
    criteria.set(c.criterion, {
      earned: true,
      standing: own || (!c.carried && !c.release) ? 'stands' : 'carried',
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
    // unknown whether what is served carries it: the gate would ask, so this read decides nothing
    const earned = c.undecided ? null : false;
    criteria.set(c.criterion, { earned, standing: c.standing, reason: c.why, weighedOn });
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
    // a project with no production delivers at its landing or its change request: weighed there
    const delivery = await deliveryOf(issue.projectId);
    if (delivery) return await atDelivered(issue, delivery);
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
