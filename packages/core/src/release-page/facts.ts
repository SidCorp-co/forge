// What a release page is read from beyond the release record itself: the files kept on its issues
// (where a cited clip or picture is), and each carried requirement's own words (its tldr and live
// criteria), which the highlights are drafted from and the requirements section quotes. Its criteria
// are the record's own (`release-batch/release-read.ts:readReleaseRecord`), never read again here.

import type { ReleaseDetail } from '@forge/contracts/releases';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueAttachments } from '../db/schema.js';
import {
  requirementCriteria,
  requirementRevisions,
  requirements,
} from '../db/schema-requirements.js';
import { listCriteriaOf } from '../issues/index.js';
import type { CarriedRequirement, IssueFile } from './claims.js';

/** The live criteria statements of each carried issue with no release note, by issue key. */
export async function unnotedCriteria(detail: ReleaseDetail): Promise<Map<string, string[]>> {
  const unnoted = new Set(detail.notes.withoutNotes.map((i) => i.key));
  const issues = detail.issues.filter((i) => unnoted.has(i.key));
  if (issues.length === 0) return new Map();
  const criteria = await listCriteriaOf(
    db,
    issues.map((i) => i.id),
  );
  return new Map(
    issues.map((i) => [i.key, (criteria.get(i.id) ?? []).map((c) => c.statement)] as const),
  );
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
