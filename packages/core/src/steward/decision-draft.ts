// The two answers to a draft no agreed requirement fits (REQ-48 BC-5): `link` ties it to the
// requirement the answer names, inside the answer's transaction, and has the steward diagnose it
// again, which prepares its criteria and asks whether to open it; `requirement` starts a
// draft requirement from the feedback the draft carries, as the requirement door writes one, in the
// answer's own transaction, and the assistant is asked for its area as on any new requirement. `decision-act.ts` records the answer and logs each as a steward act.

import { requirementKey } from '@forge/contracts/requirements';
import type { StuckCode } from '@forge/contracts/steward';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { linkIssueToRequirement } from '../issues/index.js';
import { RefusalError } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { emitEvent } from '../outbox/index.js';
import {
  createRequirementIn,
  linkRefusalOn,
  lockRequirements,
  proposePlacementLater,
  requirementIdIn,
  rowIn,
} from '../requirements/index.js';

/** Link the draft to `requirement` in `tx`, and emit it stuck again; whether this call made the link. */
export async function linkDraftIn(
  tx: Tx,
  a: {
    projectId: string;
    issue: { id: string; requirementId: string | null };
    key: string;
    requirement: string;
    stuckCode: StuckCode;
  },
): Promise<boolean> {
  const requirementId = await requirementIdIn(tx, a.projectId, a.requirement);
  if (!requirementId) throw notFound(`no ${a.requirement} in this project`);
  const row = await rowIn(tx, a.projectId, requirementId);
  const refusal = await linkRefusalOn(
    a.projectId,
    row.status as Parameters<typeof linkRefusalOn>[1],
  );
  if (refusal) throw new RefusalError([refusal], refusal.code);
  if (a.issue.requirementId && a.issue.requirementId !== requirementId) {
    const holder = requirementKey((await rowIn(tx, a.projectId, a.issue.requirementId)).reqSeq);
    throw new RefusalError(
      [
        {
          code: 'REQUIREMENT_ISSUE_LINKED_ELSEWHERE',
          path: '/optionId',
          detail: `${a.key} already delivers ${holder}; unlink it there first (DELETE /api/projects/:id/requirements/${holder}/issues/${a.key}), or answer drop.`,
        },
      ],
      'REQUIREMENT_ISSUE_LINKED_ELSEWHERE',
    );
  }
  // a draft already linked there keeps its link and the plan revision it holds
  const linked = a.issue.requirementId !== requirementId;
  if (linked) {
    await linkIssueToRequirement(tx, a.issue.id, requirementId, { plannedRevision: null });
  }
  // the steward diagnoses the draft again: it prepares the criteria, then asks to open it
  await emitEvent(tx, 'standing.stuck', {
    projectId: a.projectId,
    subject: { kind: 'issue', id: a.issue.id, key: a.key },
    basis: `linked:${requirementId}`,
    code: a.stuckCode,
  });
  return linked;
}

/** The feedback the draft carries, newest first: the case a requirement started from it reads. */
async function feedbackOf(issueId: string) {
  return rowsOf<{ fb_seq: number; title: string; body: string | null }>(
    await db.execute(sql`
      SELECT f.fb_seq, f.title, f.body FROM feedback f
       WHERE f.issue_id = ${issueId}
          OR f.id IN (SELECT c.feedback_id FROM feedback_route_issues c WHERE c.issue_id = ${issueId})
       ORDER BY f.fb_seq DESC`),
  );
}

/**
 * Start a draft requirement from the draft's feedback as the answerer, in the answer's transaction,
 * so the answer, the requirement and the act land together or not at all. The answer's own
 * `writer` authority is the permission it is written under. Its key and the record it started from.
 */
export async function startRequirementIn(
  tx: Tx,
  a: {
    projectId: string;
    actor: { userId: string; agency: 'human' | 'agent' };
    issue: { id: string; title: string };
    key: string;
    said: string;
  },
): Promise<{ id: string; made: string; from: string }> {
  const [fb] = await feedbackOf(a.issue.id);
  const from = fb ? `FB-${fb.fb_seq}` : a.key;
  await lockRequirements(tx, a.projectId);
  const written = await createRequirementIn(tx, {
    projectId: a.projectId,
    actor: a.actor,
    title: (fb?.title ?? a.issue.title).slice(0, 200),
    write: {
      reason: `Started from ${from}, carried by ${a.key}, on ${a.said}: no agreed requirement fit it.${fb?.body ? ` ${fb.body.slice(0, 1500)}` : ''}`,
      criteria: [],
    },
  });
  if (written.refusals) {
    throw new RefusalError(written.refusals, written.refusals[0]?.code ?? 'REQUIREMENT_REFUSED');
  }
  const [row] = rowsOf<{ req_seq: number }>(
    await tx.execute(sql`SELECT req_seq FROM requirements WHERE id = ${written.id}`),
  );
  if (!row) throw new Error(`steward: the requirement ${written.id} just written does not read`);
  return { id: written.id, made: requirementKey(row.req_seq), from };
}

/** After the answer commits: the assistant is asked for the new requirement's area and short name. */
export function proposeItsPlacement(projectId: string, requirementId: string): void {
  proposePlacementLater(projectId, requirementId, 'a steward start');
}
