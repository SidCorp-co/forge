import { judgedOnOf } from '@forge/contracts/delivery-policy';
import type { CriterionClass } from '@forge/contracts/issue-design';
import type { LandingArtifact, ReadPaths } from '@forge/contracts/landing-artifacts';
import type { ReleaseNotes } from '@forge/contracts/release-notes';
import type { ReleaseVerdictReading } from '@forge/contracts/release-page';
import type { ReleasedLine } from '@forge/contracts/released-line';
import type { ReleaseCriterionView, ReleasePerson } from '@forge/contracts/releases';
import type { RequirementState } from '@forge/contracts/requirements';
import { requirementKey } from '@forge/contracts/requirements';
import { criterionStandingOf, identityPhraseOf } from '@forge/contracts/verdict-identity';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerId } from '../db/read-memo.js';
import { issues, jobs, pipelineRuns } from '../db/schema.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';
import { requirements } from '../db/schema-requirements.js';
import {
  activeIssuePrefix,
  builderFactMissingSql,
  builderFactOwedSql,
  builderFactSql,
  type CriterionWithVerdict,
  criterionRoutesOf,
  listCriteriaOf,
  notCloseVerdictSql,
  readWithBuilderFacts,
  reopenedMovesOf,
  voidedUpTo,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { readProjectDocument, readVerifiedJudge } from '../project-config/index.js';
import { completionStandingsOf, issueNamingOf, namedIssue } from '../requirements/index.js';
import {
  criteriaBasisOf,
  type LandingCriteriaReport,
  landingCriteriaReports,
} from './criteria-basis.js';
import { issuesJudgedOnRelease } from './judged-on-release.js';
import type { CompletionFacts } from './release-view.js';
import { holdsReleasedLine, releasedLineOf } from './released-line.js';

export interface IssueFact {
  id: string;
  key: string;
  title: string;
  status: string;
  updatedAt: Date;
  releaseNotes: ReleaseNotes | null;
  requirementId: string | null;
  /** Each live criterion read by its latest verdict but a close's (ISS-1148): what a release with no
   *  cut build counts. */
  criteria: ReleaseCriterionView[];
  /** Each live criterion's class in the issue's design, by its number; one with none recorded is
   *  absent, and reads as an observable one (`countedForClass`, ISS-914). */
  classes: ReadonlyMap<number, CriterionClass>;
  /** Every verdict each live criterion earned since the issue's last reopen, by its number. */
  verdicts: ReadonlyMap<number, readonly CarriedVerdict[]>;
  /** Every verdict that reopen voided, by number: what a release shipped before it still reads
   *  (`judged-before-reopen.ts`, ISS-900). */
  voided: ReadonlyMap<number, readonly CarriedVerdict[]>;
  /** The issue's last move to `reopen`: its note and mark after it are a later round's. */
  reopenedAt: Date | null;
  /** Every move of a reopened issue into `closed`, oldest first (empty for any other issue). */
  closedAt: Date[];
  /** The merged mark's columns, which `landing-surfaces.ts` reads what the landing changed from. */
  merged: {
    at: Date | null;
    landing: string | null;
    artifacts: LandingArtifact[] | null;
    commitSha: string | null;
    readPaths: ReadPaths | null;
  };
}

/**
 * Who cut a release run, as the cut recorded it (`metadata.cutAs`, `create.ts:openClaimedRun`):
 * Forge unattended, naming nobody, or the person whose release job it queued (ISS-1153).
 */
export type ReleaseCutter = { as: 'automatic' } | { as: 'person'; person: ReleasePerson };

export interface ReleaseFacts {
  issues: Map<string, IssueFact>;
  requirements: Map<string, CompletionFacts>;
  /** Who cut each release run, by its id; a run naming nobody is absent. */
  cutters: Map<string, ReleaseCutter>;
  /** The project's judge (`qa`), which the verified rule reads (contracts `verified-rule.ts:verifiedOf`). */
  judge: VerifiedJudge | null;
  /**
   * The testing environment the project's releases are proven on (`delivery.judgedOn`, REQ-36
   * BC-18), or null where a commit verdict at the release's build proves it (BC-20).
   */
  judgedOn: string | null;
  /**
   * Where production names no commit it serves, what its agent's release record says shipped and
   * what each release carries (`released-line.ts:releasedLineOf`, ISS-900); null on any other project.
   */
  released: ReleasedLine | null;
  /** The issues of the project holding a verdict judged on a release, loaded beside the rosters'. */
  judgedOnRelease: readonly string[];
  /**
   * Where the project earns criteria at an issue's landing (`criteria-basis.ts:criteriaBasisOf`), what
   * each issue earned there, by issue id: the weighing the issue's own criteria read shows
   * (`criteria-weighing.ts`, `landingCriteriaReports`), so a release never reads open what its issue
   * reads earned (FB-515). Null on a project weighing at what is served.
   */
  landing: ReadonlyMap<string, LandingEarned> | null;
}

/** One issue's criteria as its landing weighs them: the numbers it earned there. */
export interface LandingEarned {
  earned: ReadonlySet<number>;
}

type LandingCounted = LandingCriteriaReport['counted'];

/** What each of `issueIds` counts at its landing, where the project's basis is the landing; else null. */
async function landingCountedOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, LandingCounted> | null> {
  if (issueIds.length === 0) return null;
  const basis = await criteriaBasisOf(projectId);
  if (basis.kind !== 'landing') return null;
  const reports = await landingCriteriaReports(projectId, issueIds);
  return new Map(reports.map((r) => [r.issueId, r.counted]));
}

/**
 * What each issue earned at its landing on a verdict other than its close's (ISS-1148): the close's
 * is its builder's word, which the issue weighs earned and its requirement counts, but which proves no
 * release. An issue's carried verdicts hold none of a close's (`carriedRowsOf`), so a criterion counts
 * where one of them names the commit its landing counted it at; one judged on a release is never a
 * close's.
 */
function earnedByJudge(
  counted: ReadonlyMap<string, LandingCounted> | null,
  facts: ReadonlyMap<string, IssueFact>,
): Map<string, LandingEarned> | null {
  if (!counted) return null;
  return new Map(
    [...counted].map(([id, list]) => {
      const judged = (n: number, at: string) =>
        (facts.get(id)?.verdicts.get(n) ?? []).some(
          (v) => (v.commitSha ?? v.runtimeRef)?.toLowerCase() === at.toLowerCase(),
        );
      const earned = list.filter((c) => c.release !== undefined || judged(c.criterion, c.at));
      return [id, { earned: new Set(earned.map((c) => c.criterion)) }];
    }),
  );
}

/** What a release reads its criteria's proof by: the project's judge, its testing environment, and
 *  where its releases are its agent's record, what each carries (ISS-900). */
export type ReleaseProof = Pick<ReleaseFacts, 'judge' | 'judgedOn'> &
  Partial<Pick<ReleaseFacts, 'released' | 'landing'>>;

/** One verdict a carried criterion earned, as a release reads it. */
export interface CarriedVerdict extends ReleaseVerdictReading {
  id: string;
  criterionId: string;
  reason: string | null;
  evidence: readonly string[];
  agency: 'human' | 'agent';
  /** Recorded by the issue's builder (`issues/built-by.ts`): the verified rule reads it (contracts `verified-rule.ts:unverifiedWhy`). */
  byBuilder: boolean;
  /** Names who recorded it, an account or a box. */
  authored: boolean;
  /** When it was recorded (`at`), as the verified rule reads it. */
  recordedAt: string;
}

/**
 * Every verdict on `criterionIds`, by criterion, each oldest first: what a release reads a criterion
 * it carries by, and what its page lists from the same reading (`criterionReadingsAt`). Keyed so a reader takes one criterion's own verdicts, never a scan of all of them per
 * criterion: across a project's releases that scan grew with the square of its release count.
 */
async function carriedVerdictsOf(
  criterionIds: readonly string[],
): Promise<Map<string, CarriedVerdict[]>> {
  const out = new Map<string, CarriedVerdict[]>();
  if (criterionIds.length === 0) return out;
  const ids = [...new Set(criterionIds)];
  // the builder rule is read from the model each write keeps (`issues/builder-facts.ts`)
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const rows = await rowsPerId('carriedVerdicts', ids, carriedRowsOf, (v) => v.criterionId);
  for (const v of rows) {
    const held = out.get(v.criterionId) ?? [];
    held.push({
      id: v.id,
      criterionId: v.criterionId,
      verdict: v.verdict as CarriedVerdict['verdict'],
      identityKind: v.identityKind,
      commitSha: v.commitSha,
      runtimeRef: v.runtimeRef,
      releaseVersion: v.releaseVersion,
      at: v.createdAt.toISOString(),
      reason: v.reason,
      evidence: v.evidence ?? [],
      agency: v.agency,
      byBuilder: v.byBuilder === true,
      authored: v.authored === true,
      recordedAt: v.createdAt.toISOString(),
    });
    out.set(v.criterionId, held);
  }
  return out;
}

const carriedRowsOf = (ids: readonly string[]) =>
  readWithBuilderFacts(
    db,
    () =>
      db
        .select({
          id: criterionVerdicts.id,
          issueId: criterionVerdicts.issueId,
          criterionId: criterionVerdicts.criterionId,
          verdict: criterionVerdicts.verdict,
          reason: criterionVerdicts.reason,
          identityKind: criterionVerdicts.identityKind,
          commitSha: criterionVerdicts.commitSha,
          runtimeRef: criterionVerdicts.runtimeRef,
          releaseVersion: criterionVerdicts.releaseVersion,
          evidence: criterionVerdicts.evidence,
          agency: criterionVerdicts.authorAgency,
          createdAt: criterionVerdicts.createdAt,
          byBuilder: builderFactSql(sql`${criterionVerdicts.id}`),
          factOwed: builderFactOwedSql(
            sql`${criterionVerdicts.issueId}`,
            sql`${criterionVerdicts.id}`,
          ),
          factMissing: builderFactMissingSql(sql`${criterionVerdicts.id}`),
          authored: sql<boolean>`(${criterionVerdicts.authorUserId} IS NOT NULL OR ${criterionVerdicts.authorDeviceId} IS NOT NULL)`,
        })
        .from(criterionVerdicts)
        // a close's verdict is its builder's word, never a judging of what shipped (ISS-1148)
        .where(
          and(
            inArray(criterionVerdicts.criterionId, [...ids]),
            notCloseVerdictSql(criterionVerdicts.reason),
          ),
        )
        .orderBy(asc(criterionVerdicts.createdAt)),
    (v) => (v.factOwed ? { issueId: v.issueId, missing: v.factMissing } : null),
  );

function criterionView(c: CriterionWithVerdict, voidedBy: Date | undefined): ReleaseCriterionView {
  const stale =
    voidedBy && c.latest && new Date(c.latest.createdAt).getTime() <= voidedBy.getTime();
  const latest = stale ? null : c.latest;
  return {
    n: c.n,
    statement: c.statement,
    standing: criterionStandingOf(latest),
    bc: null,
    identity: latest ? identityPhraseOf(latest) : null,
    reason: latest?.reason ?? null,
    judgedAt: latest?.createdAt ?? null,
    judgedBy: latest?.authorAgency ?? null,
    // set by `criteriaAt`, which reads every verdict by the verified rule
    proven: false,
    unverified: null,
  };
}

async function requirementFacts(
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, CompletionFacts>> {
  if (ids.length === 0) return new Map();
  // a requirement's rows are its own: every project's asks are one read each (ISS-1070 r6)
  const rows = (
    await rowsPerId(
      'releaseRequirements',
      ids,
      (some) =>
        db
          .select({
            id: requirements.id,
            projectId: requirements.projectId,
            status: requirements.status,
            currentRevision: requirements.currentRevision,
            ownerId: requirements.ownerId,
            updatedAt: requirements.updatedAt,
            seq: requirements.reqSeq,
            title: requirements.title,
          })
          .from(requirements)
          .where(inArray(requirements.id, [...some])),
      (r) => r.id,
    )
  ).filter((r) => r.projectId === projectId);
  const [standings, prefix, live] = await Promise.all([
    completionStandingsOf(projectId, rows),
    activeIssuePrefix(projectId),
    rowsPerId(
      'releaseRequirementIssues',
      ids,
      (some) =>
        db
          .select({
            id: issues.id,
            projectId: issues.projectId,
            issSeq: issues.issSeq,
            status: issues.status,
            requirementId: issues.requirementId,
          })
          .from(issues)
          .where(and(inArray(issues.requirementId, [...some]), ne(issues.status, 'dropped'))),
      (i) => i.requirementId as string,
    ),
  ]);
  const naming = await issueNamingOf(projectId, prefix, live);
  return new Map(
    rows.flatMap((r) => {
      const standing = standings.get(r.id);
      if (!standing) return [];
      const fact: CompletionFacts = {
        key: requirementKey(r.seq),
        title: r.title,
        status: r.status,
        state: standing.state as RequirementState,
        coverage: standing.coverage,
        live: live
          .filter((i) => i.requirementId === r.id)
          .map((i) => ({ id: i.id, key: namedIssue(naming, i).displayId, status: i.status })),
      };
      return [[r.id, fact] as const];
    }),
  );
}

async function cuttersOf(runIds: readonly string[]): Promise<Map<string, ReleaseCutter>> {
  if (runIds.length === 0) return new Map();
  const rows = await rowsPerId(
    'releaseCutters',
    runIds,
    (some) =>
      db
        .select({
          runId: pipelineRuns.id,
          cutAs: sql<string | null>`${pipelineRuns.metadata} ->> 'cutAs'`,
          createdBy: jobs.createdBy,
        })
        .from(pipelineRuns)
        .leftJoin(
          jobs,
          and(eq(jobs.pipelineRunId, pipelineRuns.id), eq(jobs.type, 'release_batch')),
        )
        .where(inArray(pipelineRuns.id, [...some]))
        .orderBy(asc(jobs.queuedAt)),
    (r) => r.runId,
  );
  // an automatic cut's job is queued as the owner it acts for, who is no cutter: never read as one
  const people = await peopleOf(
    rows.flatMap((r) => (r.cutAs !== 'automatic' && r.createdBy ? [r.createdBy] : [])),
  );
  const out = new Map<string, ReleaseCutter>();
  for (const r of rows) {
    if (out.has(r.runId)) continue;
    if (r.cutAs === 'automatic') {
      out.set(r.runId, { as: 'automatic' });
      continue;
    }
    // a cut before ISS-1153 recorded no marker, and reads its job's creator as it always did
    const p = r.createdBy ? people.get(r.createdBy) : undefined;
    if (p) out.set(r.runId, { as: 'person', person: { id: r.createdBy as string, ...p } });
  }
  return out;
}

/**
 * One criterion's verdicts, oldest first, split at the instant its issue's last reopen voids them
 * (`voidedUpTo`, ISS-845): those after it, which it earned since, and those it voided, which a
 * release shipped before the reopen still reads (ISS-900); `voidedBy` is that instant, or undefined
 * where the reopen voids none of them.
 */
function splitAtReopen(
  own: readonly CarriedVerdict[],
  reopenedAt: Date | undefined,
): { voidedBy: Date | undefined; kept: CarriedVerdict[]; voided: CarriedVerdict[] } {
  const newestFirst = [...own].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const voidedBy = voidedUpTo(newestFirst, reopenedAt) ?? undefined;
  const cut = voidedBy?.getTime() ?? Number.NEGATIVE_INFINITY;
  const kept: CarriedVerdict[] = [];
  const voided: CarriedVerdict[] = [];
  for (const v of own) (new Date(v.at).getTime() > cut ? kept : voided).push(v);
  return { voidedBy, kept, voided };
}

export async function loadReleaseFacts(
  projectId: string,
  issueIds: readonly string[],
  runIds: readonly string[],
): Promise<ReleaseFacts> {
  // the line is read beside everything below, none of which waits on its reads: whether the project
  // holds one is its document's, and the issues judged on a release are asked of every project at
  // once, so each issue's rows, criteria, reopen and close are asked once, one wave in (ISS-1070 r17)
  const releasedRead = releasedLineOf(projectId);
  // awaited at the end, where its failure is thrown; never an unhandled rejection meanwhile
  releasedRead.catch(() => undefined);
  // a verdict names a release only where the line is the agent's record (`VERDICT_RELEASE_UNUSED`
  // refuses one anywhere else), so a project with no line holds none, and its reads ask nothing more
  const judgedOnRelease = (await holdsReleasedLine(projectId))
    ? await issuesJudgedOnRelease(projectId)
    : [];
  const ids = [...new Set([...issueIds, ...judgedOnRelease])];
  // the landing basis waits on production's reading where a project has one: the reads after these
  // do not wait on it, so a project deployed through a binding asks them beside every other project
  const landingRead = landingCountedOf(projectId, ids);
  // awaited at the end, where its failure is thrown; never an unhandled rejection meanwhile
  landingRead.catch(() => undefined);
  const [rows, prefix, cutters, judge, held, criteria, reopened] = await Promise.all([
    rowsPerId(
      'releaseIssueRows',
      ids,
      (some) =>
        db
          .select({
            id: issues.id,
            projectId: issues.projectId,
            seq: issues.issSeq,
            title: issues.title,
            status: issues.status,
            updatedAt: issues.updatedAt,
            releaseNotes: issues.releaseNotes,
            requirementId: issues.requirementId,
            mergedAt: issues.mergedAt,
            mergedLanding: issues.mergedLanding,
            mergedArtifacts: issues.mergedArtifacts,
            mergedCommitSha: issues.mergedCommitSha,
            mergedPaths: issues.mergedPaths,
          })
          .from(issues)
          .where(inArray(issues.id, [...some])),
      (r) => r.id,
    ).then((all) => all.filter((r) => r.projectId === projectId)),
    activeIssuePrefix(projectId),
    cuttersOf(runIds),
    readVerifiedJudge(projectId),
    readProjectDocument(projectId),
    // a criterion reads its newest verdict but a close's, as its carried verdicts do (ISS-1148)
    listCriteriaOf(db, ids, true),
    // only a reopen's void reads a close: read with the reopen, as a release's rounds read it
    reopenedMovesOf(db, ids),
  ]);
  const criterionIds = [...criteria.values()].flatMap((list) => list.map((c) => c.id));
  const [reqs, verdicts, routes] = await Promise.all([
    requirementFacts(
      projectId,
      rows.flatMap((r) => (r.requirementId ? [r.requirementId] : [])),
    ),
    carriedVerdictsOf(criterionIds),
    criterionRoutesOf(criterionIds),
  ]);
  const byIssue = new Map<string, IssueFact>(
    rows.map((r) => {
      const read = (criteria.get(r.id) ?? []).map((c) => ({
        c,
        ...splitAtReopen(verdicts.get(c.id) ?? [], reopened.get(r.id)?.at),
      }));
      return [
        r.id,
        {
          id: r.id,
          key: r.seq != null ? formatIssueRef(prefix, r.seq) : r.id,
          title: r.title ?? '(untitled)',
          status: r.status,
          updatedAt: r.updatedAt,
          releaseNotes: r.releaseNotes ?? null,
          requirementId: r.requirementId,
          criteria: read.map(({ c, voidedBy }) => criterionView(c, voidedBy)),
          classes: new Map(
            read.flatMap(({ c }) => {
              const route = routes.get(c.id);
              return route ? [[c.n, route.class] as const] : [];
            }),
          ),
          verdicts: new Map(read.map(({ c, kept }) => [c.n, kept])),
          voided: new Map(read.map(({ c, voided }) => [c.n, voided])),
          reopenedAt: reopened.get(r.id)?.at ?? null,
          closedAt: [...(reopened.get(r.id)?.closes ?? [])],
          merged: {
            at: r.mergedAt,
            landing: r.mergedLanding,
            artifacts: r.mergedArtifacts ?? null,
            commitSha: r.mergedCommitSha?.trim() ? r.mergedCommitSha.trim() : null,
            readPaths: r.mergedPaths ?? null,
          },
        },
      ];
    }),
  );
  for (const req of reqs.values()) {
    for (const bc of req.coverage) {
      for (const link of bc.issues) {
        const view = byIssue.get(link.issueId)?.criteria.find((c) => c.n === link.criterion);
        if (view && !link.stale) view.bc = bc.code;
      }
    }
  }
  return {
    issues: byIssue,
    requirements: reqs,
    cutters,
    judge,
    judgedOn: judgedOnOf(held?.document.delivery),
    released: await releasedRead,
    judgedOnRelease,
    landing: earnedByJudge(await landingRead, byIssue),
  };
}
