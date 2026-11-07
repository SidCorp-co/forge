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
import { issues, jobs } from '../db/schema.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';
import { requirements } from '../db/schema-requirements.js';
import {
  activeIssuePrefix,
  builderCandidatesAcrossSql,
  type CriterionWithVerdict,
  closedAtOf,
  criterionRoutesOf,
  listCriteriaOf,
  reopenedAtOf,
  verdictByBuilderSql,
  voidedUpTo,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { readProjectDocument, readVerifiedJudge } from '../project-config/index.js';
import { completionStandingsOf, issueNamingOf, namedIssue } from '../requirements/index.js';
import { criteriaBasisOf, landingCriteriaReports } from './criteria-basis.js';
import type { CompletionFacts } from './release-view.js';
import { releasedLineOf } from './released-line.js';

export interface IssueFact {
  id: string;
  key: string;
  title: string;
  status: string;
  updatedAt: Date;
  releaseNotes: ReleaseNotes | null;
  requirementId: string | null;
  /** Each live criterion read by its latest verdict: what a release with no cut build counts. */
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
  /** Every move of the issue into `closed`, oldest first: the moments releases shipped it. */
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

export interface ReleaseFacts {
  issues: Map<string, IssueFact>;
  requirements: Map<string, CompletionFacts>;
  cutters: Map<string, ReleasePerson>;
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

/** Each of `issueIds` weighed at its landing, where the project's basis is the landing; else null. */
async function landingEarnedOf(
  projectId: string,
  issueIds: readonly string[],
): Promise<Map<string, LandingEarned> | null> {
  if (issueIds.length === 0) return null;
  const basis = await criteriaBasisOf(projectId);
  if (basis.kind !== 'landing') return null;
  const reports = await landingCriteriaReports(projectId, issueIds);
  return new Map(
    reports.map((r) => [r.issueId, { earned: new Set(r.counted.map((c) => c.criterion)) }]),
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
  // every carried issue's builder sessions, read once for the statement rather than per verdict
  const candidates = builderCandidatesAcrossSql(
    sql`(SELECT ic.issue_id FROM issue_criteria ic WHERE ic.id IN (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}))`,
  );
  const rows = await db
    .select({
      id: criterionVerdicts.id,
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
      byBuilder: verdictByBuilderSql({
        issueId: sql`(SELECT ic.issue_id FROM issue_criteria ic WHERE ic.id = ${criterionVerdicts.criterionId})`,
        authorUser: sql`${criterionVerdicts.authorUserId}`,
        authorDevice: sql`${criterionVerdicts.authorDeviceId}`,
        at: sql`${criterionVerdicts.createdAt}`,
        runSession: sql`${criterionVerdicts.runSessionId}`,
        candidates,
      }),
      authored: sql<boolean>`(${criterionVerdicts.authorUserId} IS NOT NULL OR ${criterionVerdicts.authorDeviceId} IS NOT NULL)`,
    })
    .from(criterionVerdicts)
    .where(inArray(criterionVerdicts.criterionId, ids))
    .orderBy(asc(criterionVerdicts.createdAt));
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
  const rows = await db
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
    .where(and(eq(requirements.projectId, projectId), inArray(requirements.id, [...ids])));
  const [standings, prefix, live] = await Promise.all([
    completionStandingsOf(projectId, rows),
    activeIssuePrefix(projectId),
    db
      .select({
        id: issues.id,
        projectId: issues.projectId,
        issSeq: issues.issSeq,
        status: issues.status,
        requirementId: issues.requirementId,
      })
      .from(issues)
      .where(and(inArray(issues.requirementId, [...ids]), ne(issues.status, 'dropped'))),
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

async function cuttersOf(runIds: readonly string[]): Promise<Map<string, ReleasePerson>> {
  if (runIds.length === 0) return new Map();
  const rows = await db
    .select({ runId: jobs.pipelineRunId, createdBy: jobs.createdBy })
    .from(jobs)
    .where(and(inArray(jobs.pipelineRunId, [...runIds]), eq(jobs.type, 'release_batch')))
    .orderBy(asc(jobs.queuedAt));
  const people = await peopleOf(rows.map((r) => r.createdBy));
  const out = new Map<string, ReleasePerson>();
  for (const r of rows) {
    const p = people.get(r.createdBy);
    if (p && !out.has(r.runId)) out.set(r.runId, { id: r.createdBy, ...p });
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
  const released = await releasedLineOf(projectId);
  // a verdict names a release only where the line is the agent's record (`VERDICT_RELEASE_UNUSED`
  // refuses one anywhere else), so a project with no line holds none, and its reads ask nothing more
  const judgedOnRelease = released ? await issuesJudgedOnRelease(projectId) : [];
  const ids = [...new Set([...issueIds, ...judgedOnRelease])];
  const [rows, prefix, cutters, judge, held, landing] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({
            id: issues.id,
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
          .where(and(eq(issues.projectId, projectId), inArray(issues.id, ids))),
    activeIssuePrefix(projectId),
    cuttersOf(runIds),
    readVerifiedJudge(projectId),
    readProjectDocument(projectId),
    landingEarnedOf(projectId, ids),
  ]);
  const [criteria, reopened, closed, reqs] = await Promise.all([
    listCriteriaOf(db, ids),
    reopenedAtOf(db, ids),
    closedAtOf(db, ids),
    requirementFacts(
      projectId,
      rows.flatMap((r) => (r.requirementId ? [r.requirementId] : [])),
    ),
  ]);
  const criterionIds = [...criteria.values()].flatMap((list) => list.map((c) => c.id));
  const [verdicts, routes] = await Promise.all([
    carriedVerdictsOf(criterionIds),
    criterionRoutesOf(criterionIds),
  ]);
  const byIssue = new Map<string, IssueFact>(
    rows.map((r) => {
      const read = (criteria.get(r.id) ?? []).map((c) => ({
        c,
        ...splitAtReopen(verdicts.get(c.id) ?? [], reopened.get(r.id)),
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
          reopenedAt: reopened.get(r.id) ?? null,
          closedAt: closed.get(r.id) ?? [],
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
    released,
    judgedOnRelease,
    landing,
  };
}

/** The issues of `projectId` holding a verdict judged on a release (ISS-900). */
async function issuesJudgedOnRelease(projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: criterionVerdicts.issueId })
    .from(criterionVerdicts)
    .innerJoin(issues, eq(issues.id, criterionVerdicts.issueId))
    .where(and(eq(issues.projectId, projectId), eq(criterionVerdicts.identityKind, 'release')));
  return rows.map((r) => r.id);
}
