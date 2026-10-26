/**
 * What a project with no production environment's landing says of an issue at the release gate, as
 * the steward's facts (`steward-release-facts.ts`): that its landed work is missing nothing, or which
 * verdicts it still owes at that landing. Both read the landed build through
 * `landed-build.ts:deliveredBuildsOf`; neither sends an issue anywhere.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { standingCriteriaOf } from '../issues/index.js';
import { deliveredBuildsOf, deliveryOf, landedStandings } from './landed-build.js';

const short = (sha: string) => sha.slice(0, 12);

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

/**
 * The steward's fact that an issue at the gate is missing nothing, or null where that is not so.
 * Under release mode `none` both of its reasons read the landed build: a verdict counts on the running
 * build where it was judged at the landed commit, and since no release run replays a probe there, the
 * design's proof plan is met where each criterion it plans to prove has that pass. So an issue at the
 * gate whose landing is recorded and whose every live criterion, every planned one among them, passes
 * at that commit is missing nothing, and the act owed is the master's.
 */
export async function landedCompleteFact(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  const delivery = await deliveryOf(row.projectId);
  if (!delivery) return null;
  const build = (await deliveredBuildsOf(row.projectId, delivery, [issueId])).get(
    issueId.toLowerCase(),
  );
  if (build?.sha === null && build.unread) {
    return `${build.why}. Whether its work is on that branch is unknown, not absent: read it again once the host answers.`;
  }
  if (!build?.sha) return null;
  const sha = build.sha;
  const [standing] = await landedStandings(
    [issueId],
    () => sha,
    () => build.via ?? null,
  );
  if (!standing?.owes || standing.criteria.length === 0) return null;
  if (standing.criteria.some((c) => !c.counts)) return null;
  const counted = new Set(standing.criteria.map((c) => c.criterion));
  const planned = await proofPlanned(issueId);
  if (planned.some((n) => !counted.has(n))) return null;
  const plan =
    planned.length > 0
      ? ` The design's proof plan is met the same way: each of the ${planned.length} criteria it plans to prove passes at that commit, and with no production environment no release run replays a probe.`
      : '';
  if (delivery === 'change-request' && (build.from === 'landed' || build.from === 'ahead')) {
    return `${build.basis}, and every live criterion (${[...counted].join(', ')}) stands on a pass judged at that commit. Its work is already on the branch this project releases from, with no change request left to merge, so it is landed, and no evidence is missing.${plan} Wake the master to cut the release that carries it (POST /api/projects/${row.projectId}/release-batches).`;
  }
  if (delivery === 'change-request') {
    return `${build.basis}, and every live criterion (${[...counted].join(', ')}) stands on a pass judged at that commit. This project releases by merging its change requests, with no production environment: until the request merges its unchanged head is the build its verdicts are read on, and no landing record is owed (REQ-63 BC-6).${plan} No evidence is missing: wake the master to cut the release that merges it (POST /api/projects/${row.projectId}/release-batches).`;
  }
  return `${build.basis}, and every live criterion (${[...counted].join(', ')}) stands on a pass judged at that commit. This project declares no production environment, so that landing is the running build and its verdicts are read there.${plan} No evidence is missing: wake the master to record the landing (POST /api/projects/${row.projectId}/release-records).`;
}

/**
 * The verdicts an issue whose work has landed still owes at that landing, as the steward's fact, or
 * null where it owes none or has not landed (an open change request's head). Landed work that only
 * owes judging is not code to rebuild: it stays where it is, this sentence naming each criterion
 * owed and the commit its pass is owed at, and a judge declared over it judges it (catalog-fe ISS-11
 * and ISS-14..19, 2026-10-26, were sent back to `reopen` for it, and a judge declared then read as
 * their builder). A criterion judged fail has reopened its issue already (`issues/fail-reopen.ts`).
 */
export async function landedVerdictsOwedFact(issueId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: issues.projectId, status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (row?.status !== 'awaiting_release') return null;
  const delivery = await deliveryOf(row.projectId);
  if (!delivery) return null;
  const build = (await deliveredBuildsOf(row.projectId, delivery, [issueId])).get(
    issueId.toLowerCase(),
  );
  if (!build?.sha || build.from === 'change-request') return null;
  const sha = build.sha;
  const standing = (await standingCriteriaOf([issueId])).get(issueId);
  if ((standing?.criteria ?? []).some((c) => c.verdict?.verdict === 'fail')) return null;
  const [weighed] = await landedStandings(
    [issueId],
    () => sha,
    () => build.via ?? null,
  );
  const owed = (weighed?.criteria ?? []).flatMap((c) =>
    c.counts ? [] : [`criterion ${c.criterion}: ${c.why}`],
  );
  if (owed.length === 0) return null;
  return `${build.basis}: its work has landed, and what it lacks is a counting verdict at that landing, which is judging owed, not code to rebuild. It stays at awaiting_release, owing: ${owed.join('; ')}. Wake the master to dispatch a judge at \`${short(sha)}\`.`;
}
