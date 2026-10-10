import type { LandingArtifact, ReadPaths } from '@forge/contracts/landing-artifacts';
import type { ReleaseNotes } from '@forge/contracts/release-notes';
import { type ReleaseVerdictReading, releaseStandingOf } from '@forge/contracts/release-page';
import type { ReleaseCriterionView, ReleasePerson } from '@forge/contracts/releases';
import type { RequirementState } from '@forge/contracts/requirements';
import { requirementKey } from '@forge/contracts/requirements';
import {
  commitIdentityPhrase,
  criterionStandingOf,
  identityPhraseOf,
} from '@forge/contracts/verdict-identity';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, jobs } from '../db/schema.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';
import { requirements } from '../db/schema-requirements.js';
import {
  activeIssuePrefix,
  type CriterionWithVerdict,
  listCriteriaOf,
  reopenedAtOf,
} from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { standingsOf } from '../requirements/index.js';
import type { CompletionFacts } from './release-view.js';

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
  /** The issue's last move to `reopen`: its note and mark after it are a later round's. */
  reopenedAt: Date | null;
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
}

/** One verdict a carried criterion earned, as a release reads it. */
export interface CarriedVerdict extends ReleaseVerdictReading {
  id: string;
  criterionId: string;
  reason: string | null;
  evidence: readonly string[];
  agency: 'human' | 'agent';
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
      evidence: criterionVerdicts.evidence,
      agency: criterionVerdicts.authorAgency,
      createdAt: criterionVerdicts.createdAt,
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
    at: v.createdAt.toISOString(),
    reason: v.reason,
    evidence: v.evidence ?? [],
    agency: v.agency,
  }));
}

/**
 * An issue's criteria as the release whose build is `build` counts them (`releaseStandingOf`): the
 * newest verdict on that build, or not judged where none is on it. A release with no cut build reads
 * each by its latest verdict.
 */
export function criteriaAt(issue: IssueFact, build: string | null): ReleaseCriterionView[] {
  if (build === null) return issue.criteria;
  return issue.criteria.map((c) => {
    const verdicts = issue.verdicts.get(c.n) ?? [];
    const on = [...verdicts]
      .reverse()
      .find((v) => v.identityKind === 'commit' && v.commitSha === build);
    return {
      ...c,
      standing: releaseStandingOf(verdicts, build),
      identity: on ? commitIdentityPhrase(build) : null,
      reason: on?.reason ?? null,
      judgedAt: on?.at ?? null,
      judgedBy: on?.agency ?? null,
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
        seq: issues.issSeq,
        status: issues.status,
        requirementId: issues.requirementId,
      })
      .from(issues)
      .where(and(inArray(issues.requirementId, [...ids]), ne(issues.status, 'dropped'))),
  ]);
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
          .map((i) => ({ id: i.id, key: formatIssueRef(prefix, i.seq), status: i.status })),
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
  const ids = [...new Set(issueIds)];
  const [rows, prefix, cutters] = await Promise.all([
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
  ]);
  const [criteria, reopened, reqs] = await Promise.all([
    listCriteriaOf(db, ids),
    reopenedAtOf(db, ids),
    requirementFacts(
      projectId,
      rows.flatMap((r) => (r.requirementId ? [r.requirementId] : [])),
    ),
  ]);
  const verdicts = await carriedVerdictsOf(
    [...criteria.values()].flatMap((list) => list.map((c) => c.id)),
  );
  // a reopen voids what was judged before it, as `criterionView` reads the latest
  const judged = (issueId: string) => {
    const voidedBy = reopened.get(issueId)?.getTime() ?? Number.NEGATIVE_INFINITY;
    return new Map(
      (criteria.get(issueId) ?? []).map((c) => [
        c.n,
        verdicts.filter((v) => v.criterionId === c.id && new Date(v.at).getTime() > voidedBy),
      ]),
    );
  };
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
        criteria: (criteria.get(r.id) ?? []).map((c) => criterionView(c, reopened.get(r.id))),
        verdicts: judged(r.id),
        reopenedAt: reopened.get(r.id) ?? null,
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
  return { issues: byIssue, requirements: reqs, cutters };
}
