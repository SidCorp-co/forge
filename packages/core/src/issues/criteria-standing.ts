// The verdict each live criterion of an issue stands on, for readers that weigh it against a build of
// their own: a landed build (`release-batch/landed-build.ts`), and the runtime weighing of a release
// (`release-batch/runtime-weighing.ts`). The verified rule picks it (`criteria-verdicts.ts:standingOn`).

import { judgedOnOf } from '@forge/contracts/delivery-policy';
import { projectGate } from '@forge/contracts/gate-profiles';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { recognisableIdentity } from '../messaging/verdict-identity.js';
import { listCriteria } from './criteria/store.js';
import { type CriterionVerdict, latestByNumber } from './criteria-verdicts.js';
import { readJudge, readProjectDocument } from './ports.js';
import { declaresProduction, standingOn, standingsOn } from './standing-on.js';
import { issueIdentities } from './verdict-standing.js';

/** One live criterion and the verdict it stands on by the verified rule; null where none was recorded. */
export interface StandingCriterion {
  readonly criterion: number;
  readonly verdict: CriterionVerdict | null;
}

/** One issue's live criteria as a landed build weighs them (`standingCriteriaOf`). */
export interface IssueStandingCriteria {
  owes: boolean;
  /** The project's testing environment (`delivery.judgedOn`, REQ-36 BC-18), or null where it names none. */
  judgedOn: string | null;
  criteria: StandingCriterion[];
}

/**
 * Each issue's live criteria and the verdict each stands on (`standingOn`), for a reader that weighs
 * them against a build of its own (`release-batch/landed-build.ts`). `owes` is false where the
 * project's document says `delivery.verdictsRequired: false`: its issues owe no verdict.
 */
export async function standingCriteriaOf(
  issueIds: readonly string[],
): Promise<Map<string, IssueStandingCriteria>> {
  const out = new Map<string, IssueStandingCriteria>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({ id: issues.id, projectId: issues.projectId })
    .from(issues)
    .where(inArray(issues.id, [...issueIds]));
  const projects = new Map<
    string,
    {
      owes: boolean;
      judgedOn: string | null;
      production: boolean;
      judge: Awaited<ReturnType<typeof readJudge>>;
    }
  >();
  for (const { projectId } of rows) {
    if (projects.has(projectId)) continue;
    const document = (await readProjectDocument(projectId))?.document;
    const delivery = document?.delivery;
    projects.set(projectId, {
      owes: projectGate(document, null, 'release_criteria').mode !== 'off',
      judgedOn: judgedOnOf(delivery),
      production: declaresProduction(document),
      judge: await readJudge(projectId),
    });
  }
  const projectOf = (id: string) => projects.get(rows.find((r) => r.id === id)?.projectId ?? '');
  const standings = await standingsOn(
    rows.map((r) => r.id),
    (id) => projectOf(id)?.judge ?? null,
    (id) => projectOf(id)?.production ?? true,
  );
  for (const row of rows) {
    const project = projects.get(row.projectId);
    const stands = standings.get(row.id) ?? { criteria: [], unverified: new Map() };
    const latest = latestByNumber(stands.criteria, stands.unverified);
    out.set(row.id, {
      owes: project?.owes ?? true,
      judgedOn: project?.judgedOn ?? null,
      criteria: stands.criteria.map((c) => ({ criterion: c.n, verdict: latest.get(c.n) ?? null })),
    });
  }
  return out;
}

/** What `release-batch/runtime-weighing.ts` weighs for these issues — the project's unclaimed
 *  `awaiting_release` rows where none are named: each one's landing commit, oldest merge first,
 *  and every commit a verdict their criteria stand on was judged at (ISS-1368). */
export async function verdictWeighingInputs(
  projectId: string,
  issueIds?: readonly string[],
): Promise<{ rows: Array<{ id: string; landing: string | null }>; judged: string[] }> {
  if (issueIds && issueIds.length === 0) return { rows: [], judged: [] };
  const scope = issueIds
    ? inArray(issues.id, [...issueIds])
    : and(eq(issues.status, 'awaiting_release'), isNull(issues.releaseBatchRunId));
  const rows = await db
    .select({
      id: issues.id,
      sessionContext: issues.sessionContext,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), scope))
    .orderBy(sql`${issues.mergedAt} ASC NULLS LAST`, issues.id);
  const judged = new Set<string>();
  const judge = rows.length === 0 ? null : await readJudge(projectId);
  for (const row of rows) {
    // the commit each criterion's verdict names, which a reopen's void does not move (`standingOn`)
    const stands = await standingOn(row.id, await listCriteria(db, row.id), judge, true);
    for (const verdict of latestByNumber(stands.criteria, stands.unverified).values()) {
      if (verdict.at && recognisableIdentity(verdict.at.value)) judged.add(verdict.at.value.trim());
    }
  }
  return {
    rows: rows.map((row) => ({ id: row.id, landing: issueIdentities(row).source })),
    judged: [...judged],
  };
}
