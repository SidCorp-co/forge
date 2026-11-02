import { judgedOnOf } from '@forge/contracts/delivery-policy';
import type { LandingArtifact, ReadPaths } from '@forge/contracts/landing-artifacts';
import type { ReleaseNotes } from '@forge/contracts/release-notes';
import {
  countedOnRelease,
  notJudgedOnWhy,
  type ReleaseVerdictReading,
} from '@forge/contracts/release-page';
import { type ReleasedLine, versionsCountedOn } from '@forge/contracts/released-line';
import type { ReleaseCriterionView, ReleasePerson } from '@forge/contracts/releases';
import type { RequirementState } from '@forge/contracts/requirements';
import { requirementKey } from '@forge/contracts/requirements';
import {
  commitIdentityPhrase,
  criterionStandingOf,
  identityPhraseOf,
} from '@forge/contracts/verdict-identity';
import type { VerifiedJudge } from '@forge/contracts/verified-rule';
import { verifiedOf } from '@forge/contracts/verified-rule';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs } from '../db/schema.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';
import { requirements } from '../db/schema-requirements.js';
import {
  activeIssuePrefix,
  type CriterionWithVerdict,
  closedAtOf,
  listCriteriaOf,
  reopenedAtOf,
  verdictByBuilderSql,
  voidedUpTo,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { readProjectDocument, readVerifiedJudge } from '../project-config/index.js';
import { issueNamingOf, namedIssue, standingsOf } from '../requirements/index.js';
import { voidedStillRead } from './judged-before-reopen.js';
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
}

/** What a release reads its criteria's proof by: the project's judge, its testing environment, and
 *  where its releases are its agent's record, what each carries (ISS-900). */
export type ReleaseProof = Pick<ReleaseFacts, 'judge' | 'judgedOn'> &
  Partial<Pick<ReleaseFacts, 'released'>>;

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
 * Every verdict on `criterionIds`, oldest first: what a release reads a criterion it carries by.
 * The page reads the same rows (`release-page/facts.ts`), so the two cannot count differently.
 */
export async function carriedVerdictsOf(
  criterionIds: readonly string[],
): Promise<CarriedVerdict[]> {
  if (criterionIds.length === 0) return [];
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
      }),
      authored: sql<boolean>`(${criterionVerdicts.authorUserId} IS NOT NULL OR ${criterionVerdicts.authorDeviceId} IS NOT NULL)`,
    })
    .from(criterionVerdicts)
    .where(inArray(criterionVerdicts.criterionId, [...criterionIds]))
    .orderBy(asc(criterionVerdicts.createdAt));
  return rows.map((v) => ({
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
  }));
}

/**
 * An issue's criteria as the release whose build is `build` counts them, by the one rule every count
 * of proof reads (contracts `verified-rule.ts:verifiedOf`, REQ-35 decision 7b261fca): of the verdicts on that build,
 * the one the criterion stands on is the judge's, and only a pass the rule counts as verified proves
 * it. A short never does, nor the builder's own pass, whatever the project's `qa`; where neither
 * counts, `unverified` says why. A release with no cut build reads every verdict since the last
 * reopen, its newest shown; one with a build reads only the verdicts judged on that build
 * (`judgedOnReleaseBuild`: on a project naming a testing environment, a runtime verdict at it and
 * never a commit one, REQ-36 BC-18), so a verdict on an earlier build never counts, and none on it
 * reads not judged — "Not judged on <environment>" where the project names one (BC-19). A verdict
 * judged on a release counts on release `version` and on every release its record says carries
 * that one (`versionsCountedOn`, ISS-900).
 */
export function criteriaAt(
  issue: IssueFact,
  build: string | null,
  { judge, judgedOn, released }: ReleaseProof,
  version: string | null = null,
  /** When the release shipped; absent, as its record says (ISS-900), null where it has not. */
  shippedAt: Date | null = version === null ? null : (released?.shipped.get(version)?.at ?? null),
): ReleaseCriterionView[] {
  const versions = versionsCountedOn(released, version);
  const reader = { shippedAt, build, judgedOn, versions };
  return issue.criteria.map((c) => {
    const before = voidedStillRead(issue, c.n, reader);
    const newestFirst = [...(issue.verdicts.get(c.n) ?? []), ...before].sort((a, b) =>
      b.at.localeCompare(a.at),
    );
    const counted = newestFirst.filter((v) => countedOnRelease(v, build, judgedOn, versions));
    const read = verifiedOf(counted, judge);
    const stands = read.stands;
    const proven = read.proven && stands?.identityKind !== 'commit_unresolved';
    const unjudgedThere = build !== null && judgedOn !== null && !stands;
    const unverified = proven ? null : unjudgedThere ? notJudgedOnWhy(judgedOn, build) : read.why;
    // with no build, a verdict judged on a release still names what it stands on (ISS-900)
    if (build === null && stands?.identityKind !== 'release') return { ...c, proven, unverified };
    const at = build ?? '';
    return {
      ...c,
      standing: !stands
        ? 'unjudged'
        : stands.identityKind === 'commit_unresolved'
          ? 'unresolved'
          : stands.verdict,
      identity: stands
        ? stands.identityKind === 'release'
          ? `release ${stands.releaseVersion}`
          : judgedOn === null
            ? commitIdentityPhrase(at)
            : `runtime ${at.slice(0, 12)} on ${judgedOn}`
        : null,
      reason: stands?.reason ?? null,
      judgedAt: stands?.at ?? null,
      judgedBy: stands?.agency ?? null,
      proven,
      unverified,
    };
  });
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
    standingsOf(projectId, rows, null),
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

export async function loadReleaseFacts(
  projectId: string,
  issueIds: readonly string[],
  runIds: readonly string[],
): Promise<ReleaseFacts> {
  const [released, judgedOnRelease] = await Promise.all([
    releasedLineOf(projectId),
    issuesJudgedOnRelease(projectId),
  ]);
  const ids = [...new Set([...issueIds, ...judgedOnRelease])];
  const [rows, prefix, cutters, judge, held] = await Promise.all([
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
  const verdicts = await carriedVerdictsOf(
    [...criteria.values()].flatMap((list) => list.map((c) => c.id)),
  );
  // a reopen voids what was judged before it on a criterion not passing then (`voidedUpTo`,
  // ISS-845), as `criterionView` reads the latest
  const voidedFor = (issueId: string, criterionId: string) =>
    voidedUpTo(
      verdicts
        .filter((v) => v.criterionId === criterionId)
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
      reopened.get(issueId),
    ) ?? undefined;
  const judged = (issueId: string, kept: boolean) =>
    new Map(
      (criteria.get(issueId) ?? []).map((c) => {
        const voidedBy = voidedFor(issueId, c.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
        const after = (v: CarriedVerdict) => new Date(v.at).getTime() > voidedBy;
        return [c.n, verdicts.filter((v) => v.criterionId === c.id && after(v) === kept)];
      }),
    );
  const byIssue = new Map<string, IssueFact>(
    rows.map((r) => [
      r.id,
      {
        id: r.id,
        key: r.seq != null ? formatIssueRef(prefix, r.seq) : r.id,
        title: r.title ?? '(untitled)',
        status: r.status,
        updatedAt: r.updatedAt,
        releaseNotes: r.releaseNotes ?? null,
        requirementId: r.requirementId,
        criteria: (criteria.get(r.id) ?? []).map((c) => criterionView(c, voidedFor(r.id, c.id))),
        verdicts: judged(r.id, true),
        voided: judged(r.id, false),
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
    ]),
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
