/**
 * What an issue at the release gate's criteria are worth, as the steward's fact
 * (`steward-release-facts.ts`): each live criterion earned, owed or undecided, with the reason the one
 * weighing gives, the weighing `GET /api/issues/:id/criteria` serves (`criteria-weighing.ts:
 * criteriaWeighingOf`), read when the fact is written. ISS-1035 (FB-533): adminhub-api's steward,
 * given no weighing on a promotion project, weighed ISS-189's runtime passes at its landing against
 * what `stg` served and called them missing three minutes after the read counted them. Then the act
 * that follows: a judge where a criterion is owed, and on a project with no production the record or
 * release its delivery owes once nothing is. On a project with production an issue owing nothing
 * names the release that carries it and that release's own wait, which holds the act that ships it
 * once for every issue it carries (ISS-1040: adminhub-api's steward, told only that every criterion
 * was earned, asked the master per issue to cut or approve 0.14.0, whose standing already held the
 * promotion). It sends no issue anywhere.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import type { CriterionWeighing } from '../issues/index.js';
import { standingCriteriaOf } from '../issues/index.js';
import { carryingReleaseOf, type HoldingRelease } from './carrying-release.js';
import { criteriaWeighingOf } from './criteria-weighing.js';

const short = (sha: string) => sha.slice(0, 12);

type WeighedOn = CriterionWeighing['weighedOn'];

/** The live criteria the issue's design plans a proof for, by number. */
async function proofPlanned(issueId: string): Promise<number[]> {
  const rows = (await db.execute(sql`
    SELECT c.n FROM issue_design_criteria d
      JOIN issue_criteria c ON c.id = d.criterion_id AND c.retired_at IS NULL
     WHERE d.issue_id = ${issueId}::uuid
     ORDER BY c.n
  `)) as unknown as Array<{ n: number }>;
  return rows.map((r) => Number(r.n));
}

/** `criterion 3` or `criteria 1, 2`. */
const listed = (ns: readonly number[]) =>
  ns.length === 1 ? `criterion ${ns[0]}` : `criteria ${ns.join(', ')}`;

/** `Criterion 3 is` or `Criteria 1, 2 are`. */
const named = (ns: readonly number[]) =>
  `${listed(ns).replace(/^c/, 'C')} ${ns.length === 1 ? 'is' : 'are'}`;

const word = (w: CriterionWeighing) =>
  w.earned === true ? 'earned' : w.earned === false ? 'owed' : 'undecided';

/** Where a pass on an owed criterion is owed, in the weighing's own terms. */
function owedAt(on: WeighedOn): string {
  if (on.basis === 'delivered') return `at \`${short(on.build)}\``;
  if (on.basis === 'landing') {
    return on.landing
      ? `at \`${short(on.landing)}\`, its landing on \`${on.landsOn}\`, or at a later build that holds it`
      : 'once its merge names the commit it landed at';
  }
  if (on.basis === 'served') {
    return on.environment ? `on what \`${on.environment}\` serves` : 'on what production serves';
  }
  return 'where its reason says';
}

/**
 * The act a project with no production owes once every criterion is earned at the build it delivers:
 * record the landing, or cut the release that merges or carries it.
 */
async function deliveredAct(
  projectId: string,
  issueId: string,
  on: Extract<WeighedOn, { basis: 'delivered' }>,
  counted: readonly number[],
): Promise<string> {
  const planned = await proofPlanned(issueId);
  const plan =
    planned.length > 0
      ? ` The design's proof plan is met the same way: each of the ${planned.length} criteria it plans to prove passes at that commit, and with no production environment no release run replays a probe.`
      : '';
  const lead = `${on.said}, and every live criterion (${counted.join(', ')}) stands on a pass that counts at that commit, judged there or carried to it.`;
  const cut = `POST /api/projects/${projectId}/release-batches`;
  if (on.delivery === 'change-request' && (on.from === 'landed' || on.from === 'ahead')) {
    return `${lead} Its work is already on the branch this project releases from, with no change request left to merge, so it is landed, and no evidence is missing.${plan} Wake the master to cut the release that carries it (${cut}).`;
  }
  if (on.delivery === 'change-request') {
    return `${lead} This project releases by merging its change requests, with no production environment: until the request merges its unchanged head is the build its verdicts are read on, and no landing record is owed (REQ-63 BC-6).${plan} No evidence is missing: wake the master to cut the release that merges it (${cut}).`;
  }
  return `${lead} This project declares no production environment, so that landing is the running build and its verdicts are read there.${plan} No evidence is missing: wake the master to record the landing (POST /api/projects/${projectId}/release-records).`;
}

/**
 * The steward's fact about an issue at `awaiting_release`: its criteria as the one weighing reads them
 * now, and the act owed. Null for an issue elsewhere. A criterion owed is judging owed, not code to
 * rebuild, unless its verdict is a fail, which reopens the issue that owns the work.
 */
export async function criteriaWeighingFact(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  const weighing = await criteriaWeighingOf({ id: issueId, projectId: row.projectId });
  if (weighing.kind === 'none') {
    return `Its criteria are not weighed: ${weighing.why}. No criterion is missing a verdict on this reading, and none is earned either.`;
  }
  const all = [...weighing.criteria].sort(([a], [b]) => a - b);
  const first = all[0]?.[1];
  if (!first) return null;
  const read = `Its criteria, as \`GET /api/issues/${issueId}/criteria\` weighs them for the gate that decides it, read now: ${all
    .map(([n, w]) => `criterion ${n} ${word(w)}: ${w.reason}`)
    .join('; ')}.`;
  const owedWhere = (on?: CriterionWeighing['owedOn']) =>
    all.filter(([, w]) => w.earned === false && w.owedOn === on).map(([n]) => n);
  const atCommit = owedWhere(undefined);
  const onLive = owedWhere('live-release');
  const afterRelease = owedWhere('after-release');
  const undecided = all.filter(([, w]) => w.earned === null).map(([n]) => n);
  const after =
    afterRelease.length > 0
      ? ` ${named(afterRelease)} judged on the running product after the release that carries this issue ships: ${afterRelease.length === 1 ? 'it holds' : 'they hold'} nothing now, and no judge is owed before then.`
      : '';
  const owed = [...atCommit, ...onLive];
  if (owed.length > 0) {
    const standing = (await standingCriteriaOf([issueId])).get(issueId);
    const failed = (standing?.criteria ?? [])
      .filter((c) => owed.includes(c.criterion) && c.verdict?.verdict === 'fail')
      .map((c) => c.criterion);
    if (failed.length > 0) {
      return `${read} ${named(failed)} judged fail, which reopens the issue that owns the work: that is code to fix, not a judge to dispatch.${after}`;
    }
    const judge = [
      atCommit.length > 0 ? ` Wake the master to dispatch a judge ${owedAt(first.weighedOn)}.` : '',
      onLive.length > 0
        ? ` ${named(onLive)} judged on the running product, on the release its reason names: wake the master to dispatch a judge there.`
        : '',
    ].join('');
    return `${read} What it lacks is a counting verdict on ${listed(owed)}, which is judging owed, not code to rebuild: it stays at awaiting_release.${judge}${after}`;
  }
  if (undecided.length > 0) {
    return `${read} Whether ${listed(undecided)} ${undecided.length === 1 ? 'counts' : 'count'} is undecided until a release pass reads what is served: nothing is owed on this reading, and no judge is to be asked for.${after}`;
  }
  if (afterRelease.length > 0) {
    return `${read} Every other live criterion is earned, and no verdict is missing now.${after}`;
  }
  if (first.weighedOn.basis === 'delivered') {
    return `${read} ${await deliveredAct(
      row.projectId,
      issueId,
      first.weighedOn,
      all.map(([n]) => n),
    )}`;
  }
  return `${read} Every live criterion is earned: no verdict is missing, and no judge is owed. ${carriedBy(
    await carryingReleaseOf(row.projectId, issueId),
  )}`;
}

/** What an issue owing nothing on a project with production waits on: the release that carries it. */
function carriedBy(release: HoldingRelease | null): string {
  if (!release) {
    return 'No release that has not shipped carries it yet: the release that takes it in holds the act that ships it, so nothing is asked on this issue.';
  }
  return `It ships with release ${release.version} (${release.state.replace('_', ' ')}), whose own standing holds the act that ships it (a cut, an approval or a promotion) once for every issue it carries: ${release.line}, since ${release.since}. Nothing is asked on this issue: write the note naming that release. An ask about that act is raised once on the release, of whoever takes it, never once per issue it carries.`;
}

/**
 * The release an issue at `awaiting_release` waits on for its next act, where it owes nothing of its
 * own: every live criterion earned on a project with production, the reading `criteriaWeighingFact`
 * ends on. Null where the issue owes anything, sits elsewhere, or no release carries it.
 */
export async function releaseHoldingActOf(issueId: string): Promise<HoldingRelease | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  const weighing = await criteriaWeighingOf({ id: issueId, projectId: row.projectId });
  if (weighing.kind === 'none' || weighing.criteria.size === 0) return null;
  const all = [...weighing.criteria.values()];
  // a project with no production delivers at its landing: its act is the record or cut `deliveredAct` names
  if (!all.every((w) => w.earned === true) || all[0]?.weighedOn.basis === 'delivered') return null;
  return carryingReleaseOf(row.projectId, issueId);
}
