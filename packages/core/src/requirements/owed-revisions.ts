/**
 * Which returned requirement revisions owe their project master a revise (workflow
 * requirement-lifecycle `revisions`, edge rev_proposed → rev_draft `revision.returned`). A return
 * puts the revision back to draft with the signer's reason; an agent wrote it, so the master that
 * runs that agent revises and proposes it again, or drops it (`standing-draft.ts:draftTurn`). The
 * box carrying the master reads it on every sweep, so a return is master work whether or not its
 * requirement.returned wake was heard. A person's own returned draft waits on that person and is
 * not listed, and so is one whose requirement is deferred: it owes nothing until it is re-planned
 * (undeferred), when it is listed again (hop REQ-3..20, returned "out of v1" and deferred).
 */

import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, isNotNull, notInArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';

export interface OwedRequirementRevision {
  requirementId: string;
  key: string;
  title: string;
  revision: number;
  reason: string;
}

export async function owedRequirementRevisions(
  projectId: string,
): Promise<OwedRequirementRevision[]> {
  const rows = await db
    .select({
      id: requirements.id,
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      revision: requirementRevisions.revision,
      reason: requirementRevisions.returnReason,
    })
    .from(requirementRevisions)
    .innerJoin(requirements, eq(requirements.id, requirementRevisions.requirementId))
    .where(
      and(
        eq(requirements.projectId, projectId),
        notInArray(requirements.status, ['dropped', 'accepted', 'deferred']),
        eq(requirementRevisions.state, 'draft'),
        eq(requirementRevisions.authorAgency, 'agent'),
        isNotNull(requirementRevisions.returnReason),
      ),
    )
    .orderBy(asc(requirements.reqSeq));
  return rows.map((r) => ({
    requirementId: r.id,
    key: requirementKey(r.reqSeq),
    title: r.title,
    revision: r.revision,
    reason: r.reason ?? '',
  }));
}
