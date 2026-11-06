// An item a Product act was made on, read back after it (REQ-69 BC-5): its state now, and who made
// its last move and when, so the chat reports what the item reads and never the state the act was
// meant to leave. A requirement and a feedback item read as every chat decision's item does
// (`item-state.ts`); a workflow design reads its design status and its kernel moves; a release reads
// its page's state, whose moves are attempts rather than one recorded mover.

import type { ChatItemState } from '@forge/contracts/chat-decide';
import { type ItemActPlan, itemActKind } from '@forge/contracts/item-acts';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { kernelTransitions } from '../../db/schema.js';
import { projectWorkflows } from '../../db/schema-workflows.js';
import { isUuid } from '../../issues/index.js';
import { userNames } from '../../lib/people.js';
import { readRelease } from '../../release-batch/index.js';
import { itemStateOf } from '../item-state.js';

/** A workflow page names its flow or its uuid; the design's door takes the uuid. */
export async function workflowIdOf(projectId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ id: projectWorkflows.id })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        isUuid(key) ? eq(projectWorkflows.id, key) : eq(projectWorkflows.flow, key),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

async function workflowState(
  projectId: string,
  workflowId: string,
  key: string,
): Promise<ChatItemState | null> {
  const [row] = await db
    .select({ status: projectWorkflows.designStatus })
    .from(projectWorkflows)
    .where(and(eq(projectWorkflows.id, workflowId), eq(projectWorkflows.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  const [move] = await db
    .select({ actorId: kernelTransitions.actorId, at: kernelTransitions.createdAt })
    .from(kernelTransitions)
    .where(
      and(
        eq(kernelTransitions.entity, 'workflow_design'),
        eq(kernelTransitions.entityId, workflowId),
      ),
    )
    .orderBy(desc(kernelTransitions.createdAt))
    .limit(1);
  const names = await userNames([move?.actorId ?? null]);
  return {
    key,
    status: row.status ?? 'draft',
    movedBy: move?.actorId ? (names.get(move.actorId) ?? null) : null,
    movedAt: move?.at ? move.at.toISOString() : null,
  };
}

async function releaseState(
  projectId: string,
  userId: string,
  version: string,
): Promise<ChatItemState | null> {
  try {
    const r = await readRelease(projectId, version, {
      userId,
      agency: 'human',
      isAdmin: false,
      mayApprove: false,
    });
    return { key: r.version, status: r.state, movedBy: null, movedAt: null };
  } catch {
    // a version that reads as no release now is reported as no item, never guessed at
    return null;
  }
}

/** The item `plan` acted on, as it reads now; null where it reads as no item of the project. */
export function itemActStateOf(
  at: { projectId: string; userId: string },
  plan: ItemActPlan,
  key: string,
): Promise<ChatItemState | null> {
  const kind = itemActKind(plan.act);
  if (kind === 'requirement' || kind === 'feedback')
    return itemStateOf(at.projectId, { kind, key });
  if (kind === 'workflow') return workflowState(at.projectId, plan.ref, key);
  return releaseState(at.projectId, at.userId, plan.ref);
}
