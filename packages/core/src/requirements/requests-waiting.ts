// The chat or direct requests waiting on agreement (REQ-76 BC-9): a draft requirement whose revision
// is proposed — what a person or the assistant recorded from a chat. Under a profile that turns
// `master_admitted_only` off these are master work (`masters/owed.ts`), and the agree gate that
// profile also turns off lets the master agree and break each down itself.

import type { IntakeDraftCode } from '@forge/contracts/intake-drafts';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, exists, notExists } from 'drizzle-orm';
import { db } from '../db/client.js';
import { intakeDrafts } from '../db/schema-intake.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';

export async function proposedDraftRequirements(projectId: string): Promise<{ key: string }[]> {
  const rows = await db
    .select({ reqSeq: requirements.reqSeq })
    .from(requirements)
    .where(
      and(
        eq(requirements.projectId, projectId),
        eq(requirements.status, 'draft'),
        exists(
          db
            .select({ revision: requirementRevisions.revision })
            .from(requirementRevisions)
            .where(
              and(
                eq(requirementRevisions.requirementId, requirements.id),
                eq(requirementRevisions.state, 'proposed'),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(requirements.reqSeq));
  return rows.map((r) => ({ key: requirementKey(r.reqSeq) }));
}

/**
 * Draft requirements the intake assistant could not draft and will not try again (ISS-772,
 * requirement-lifecycle r20 start → draft: "where it cannot run, core owes the requirement to the
 * master on every sweep"): its draft ended failed with no retry owed, a withheld one from its first
 * failure, and nobody has proposed a revision of it since. Each names the failure's code. A later
 * draft that succeeds, a proposed revision or a move out of draft takes it off.
 */
export async function intakeFailedRequirements(
  projectId: string,
): Promise<{ key: string; code: IntakeDraftCode }[]> {
  const rows = await db
    .select({ reqSeq: requirements.reqSeq, code: intakeDrafts.code })
    .from(requirements)
    .innerJoin(intakeDrafts, eq(intakeDrafts.requirementId, requirements.id))
    .where(
      and(
        eq(requirements.projectId, projectId),
        eq(requirements.status, 'draft'),
        eq(intakeDrafts.outcome, 'failed'),
        eq(intakeDrafts.retryOwed, false),
        notExists(
          db
            .select({ revision: requirementRevisions.revision })
            .from(requirementRevisions)
            .where(
              and(
                eq(requirementRevisions.requirementId, requirements.id),
                eq(requirementRevisions.state, 'proposed'),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(requirements.reqSeq));
  return rows.map((r) => {
    // intake_drafts_shape_chk holds a code on every failed draft
    if (!r.code) throw new Error(`intake: REQ-${r.reqSeq}'s failed draft holds no code`);
    return { key: requirementKey(r.reqSeq), code: r.code };
  });
}
