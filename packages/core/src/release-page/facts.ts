// What a release page is read from beyond the release record itself: every verdict each carried
// criterion earned (the truth rule reads them all, not the latest), the files kept on its issues
// (where a cited clip or picture is), and each carried requirement's own words (its tldr and live
// criteria), which the highlights are drafted from and the requirements section quotes.

import type { ReleaseDetail } from '@forge/contracts/releases';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import { criterionVerdicts } from '../db/schema-issue-criteria.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { listCriteriaOf, reopenedAtOf } from '../issues/index.js';
import type { CarriedCriterion, CarriedRequirement, CarriedVerdict, IssueFile } from './claims.js';

const VERDICTS = new Set(['pass', 'short', 'fail', 'skipped']);

async function verdictsOf(criterionIds: readonly string[]) {
  if (criterionIds.length === 0) return [];
  return db
    .select({
      id: criterionVerdicts.id,
      criterionId: criterionVerdicts.criterionId,
      verdict: criterionVerdicts.verdict,
      reason: criterionVerdicts.reason,
      identityKind: criterionVerdicts.identityKind,
      commitSha: criterionVerdicts.commitSha,
      evidence: criterionVerdicts.evidence,
      createdAt: criterionVerdicts.createdAt,
    })
    .from(criterionVerdicts)
    .where(inArray(criterionVerdicts.criterionId, [...criterionIds]));
}

/**
 * Each live criterion of the issues the release carries, with every verdict it earned since the
 * issue's last reopen (a reopen voids what was judged before it, as the release record reads it),
 * and the requirement criterion it traces as the release record names it.
 */
export async function carriedCriteria(detail: ReleaseDetail): Promise<CarriedCriterion[]> {
  const issueIds = detail.issues.map((i) => i.id);
  const [criteria, reopened] = await Promise.all([
    listCriteriaOf(db, issueIds),
    reopenedAtOf(db, issueIds),
  ]);
  const all = [...criteria.values()].flat();
  const verdicts = await verdictsOf(all.map((c) => c.id));
  return detail.issues.flatMap((issue) => {
    const voidedBy = reopened.get(issue.id)?.getTime() ?? Number.NEGATIVE_INFINITY;
    const traced = detail.issueCriteria.find((i) => i.key === issue.key)?.criteria ?? [];
    return (criteria.get(issue.id) ?? []).map((c) => ({
      issueId: issue.id,
      issueKey: issue.key,
      requirementKey: issue.requirement,
      n: c.n,
      statement: c.statement,
      bc: traced.find((t) => t.n === c.n)?.bc ?? null,
      verdicts: verdicts
        .filter(
          (v) =>
            v.criterionId === c.id && v.createdAt.getTime() > voidedBy && VERDICTS.has(v.verdict),
        )
        .map(
          (v): CarriedVerdict => ({
            id: v.id,
            verdict: v.verdict as CarriedVerdict['verdict'],
            identityKind: v.identityKind,
            commitSha: v.commitSha,
            at: v.createdAt.toISOString(),
            reason: v.reason,
            evidence: v.evidence ?? [],
          }),
        ),
    }));
  });
}

export async function issueFiles(issueIds: readonly string[]): Promise<IssueFile[]> {
  if (issueIds.length === 0) return [];
  const rows = await db
    .select({
      id: issueAttachments.id,
      issueId: issueAttachments.issueId,
      name: issueAttachments.name,
      mime: issueAttachments.mime,
      bytes: issueAttachments.size,
    })
    .from(issueAttachments)
    .where(inArray(issueAttachments.issueId, [...issueIds]));
  return rows;
}

export interface RequirementText extends CarriedRequirement {
  tldr: string | null;
}

const seqOf = (key: string) => Number(key.replace(/^REQ-/, ''));

/** Each requirement the release completes or advances, with its current tldr and its live criteria by code. */
export async function carriedRequirements(
  projectId: string,
  detail: ReleaseDetail,
): Promise<RequirementText[]> {
  const carried = detail.requirementsCompleted;
  const seqs = carried.map((r) => seqOf(r.key)).filter((n) => Number.isInteger(n));
  if (seqs.length === 0) return [];
  const rows = await db
    .select({
      id: requirements.id,
      seq: requirements.reqSeq,
      tldr: requirementRevisions.tldr,
    })
    .from(requirements)
    .leftJoin(
      requirementRevisions,
      and(
        eq(requirementRevisions.requirementId, requirements.id),
        eq(requirementRevisions.revision, requirements.currentRevision),
      ),
    )
    .where(and(eq(requirements.projectId, projectId), inArray(requirements.reqSeq, seqs)));
  const ids = rows.map((r) => r.id);
  const bcs =
    ids.length === 0
      ? []
      : await db
          .select({
            requirementId: requirementCriteria.requirementId,
            code: requirementCriteria.code,
            body: requirementCriteria.body,
          })
          .from(requirementCriteria)
          .where(
            and(
              inArray(requirementCriteria.requirementId, ids),
              isNull(requirementCriteria.retiredRevision),
            ),
          );
  return carried.map((r) => {
    const row = rows.find((x) => x.seq === seqOf(r.key));
    return {
      key: r.key,
      title: r.title,
      completes: r.completes,
      tldr: row?.tldr ?? null,
      criteria: new Map(
        bcs
          .filter((b) => row && b.requirementId === row.id)
          .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
          .map((b) => [b.code, b.body] as const),
      ),
    };
  });
}
