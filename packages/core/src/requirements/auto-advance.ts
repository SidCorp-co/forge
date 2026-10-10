/**
 * A complete checklist moves a draft requirement on by itself (REQ-34 BC-20; Requirement lifecycle
 * r15 ready_check, rev_check): where the project asks no person to accept a revision or agree a
 * requirement (`approvals.revisions`, `approvals.agree` off, the default), a draft whose ready
 * checklist has every answer is proposed, accepted and agreed without anybody confirming. Each step
 * goes through the same service a person's click does, so every guard and the kernel's own checklist
 * still judge it; the act is the assistant's, on behalf of the requirement's owner (else its first
 * author), recorded with agency `agent` and a reason saying it moved by itself. A switch that is on
 * stops the advance at that step, and the move waits on a holder of the approve permission.
 */

import { personGateOn } from '@forge/contracts/person-gates';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { logger } from '../lib/logger.js';
import { readApprovals } from '../project-config/index.js';
import { acceptRevision, agreeRequirement, readyRefusalsAt } from './agree.js';
import type { RequirementActor } from './read.js';
import { openRevisionOf } from './revision-write.js';
import type { RequirementRefusal } from './rules.js';
import { proposeRevision } from './service.js';

/** What one pass did to one requirement: the steps it took, or why it stopped. */
export type AdvanceOutcome =
  | { moved: readonly ('proposed' | 'accepted' | 'agreed')[] }
  | { stopped: 'not_draft' | 'not_ready' | 'gate_on' | 'no_actor' | 'nothing_open' }
  | { refused: readonly RequirementRefusal[] };

export const ADVANCE_REASON =
  'Moved on by itself: every ready answer is in, and this project asks no person to confirm this step (REQ-34 BC-20).';

/** The person the assistant acts for: the owner, else whoever wrote the first revision. */
async function actorOf(
  requirementId: string,
  ownerId: string | null,
): Promise<RequirementActor | null> {
  if (ownerId) return { userId: ownerId, agency: 'agent' };
  const [first] = await db
    .select({ authorId: requirementRevisions.authorId })
    .from(requirementRevisions)
    .where(eq(requirementRevisions.requirementId, requirementId))
    .orderBy(asc(requirementRevisions.revision))
    .limit(1);
  return first?.authorId ? { userId: first.authorId, agency: 'agent' } : null;
}

const notReady = (row: { id: string; reqSeq: number }, revision: number) =>
  db.transaction((tx) => readyRefusalsAt(tx, row, revision)).then((r) => r.length > 0);

/** One requirement, advanced as far as its checklist and the project's switches allow. */
export async function advanceRequirement(
  projectId: string,
  requirementId: string,
): Promise<AdvanceOutcome> {
  const [row] = await db
    .select()
    .from(requirements)
    .where(and(eq(requirements.id, requirementId), eq(requirements.projectId, projectId)));
  if (!row || row.status !== 'draft') return { stopped: 'not_draft' };
  const actor = await actorOf(row.id, row.ownerId);
  if (!actor) return { stopped: 'no_actor' };
  const approvals = await readApprovals(projectId);
  const ref = requirementKey(row.reqSeq);
  const moved: ('proposed' | 'accepted' | 'agreed')[] = [];
  const open = await openRevisionOf(db, row.id);
  if (open) {
    if (await notReady(row, open.revision)) return { stopped: 'not_ready' };
    if (open.state === 'draft') {
      const out = await proposeRevision({ projectId, ref, actor, revision: open.revision });
      if (!out.ok) return { refused: out.refusals };
      moved.push('proposed');
    }
    if (personGateOn(approvals, 'revisions'))
      return moved.length ? { moved } : { stopped: 'gate_on' };
    const out = await acceptRevision({
      projectId,
      ref,
      actor,
      revision: open.revision,
      reason: ADVANCE_REASON,
    });
    if (!out.ok) return { refused: out.refusals };
    moved.push('accepted');
  }
  const head = open?.revision ?? row.currentRevision;
  if (head === null) return { stopped: 'nothing_open' };
  if (personGateOn(approvals, 'agree')) return moved.length ? { moved } : { stopped: 'gate_on' };
  if (!open && (await notReady(row, head))) return { stopped: 'not_ready' };
  const out = await agreeRequirement({
    projectId,
    ref,
    actor,
    revision: head,
    reason: ADVANCE_REASON,
  });
  if (!out.ok) return moved.length ? { moved } : { refused: out.refusals };
  moved.push('agreed');
  return { moved };
}

/**
 * The timer's pass: every draft requirement on any project, advanced. A refusal is logged and the
 * requirement keeps waiting where its standing says; the next pass reads it again.
 */
export async function advanceReadyRequirements(): Promise<{ moved: number; refused: number }> {
  const drafts = rowsOf<{ id: string; project_id: string }>(
    await db.execute(sql`
      SELECT id, project_id FROM requirements WHERE status = 'draft' ORDER BY project_id, req_seq`),
  );
  let moved = 0;
  let refused = 0;
  for (const d of drafts) {
    const out = await advanceRequirement(d.project_id, d.id);
    if ('moved' in out) moved += 1;
    if ('refused' in out) {
      refused += 1;
      logger.debug(
        { requirementId: d.id, refusals: out.refused },
        'requirement-advance: a step was refused',
      );
    }
  }
  return { moved, refused };
}
