/**
 * The requirement.delivered notice (workflow requirement-lifecycle edge in_delivery → delivered):
 * the phase is a view, so the outbox only says when a linked issue's move left it reading
 * delivered. A notice that arrives late is late; the phase read on every query is still right.
 */

import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { requirements } from '../db/schema-requirements.js';
import { consume, emitEvent } from '../outbox/index.js';
import { deliveryIn, liveBuildOfRequirement } from './acceptance.js';

async function noticeDelivered(issueId: string): Promise<void> {
  const [row] = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
    })
    .from(issues)
    .innerJoin(requirements, eq(requirements.id, issues.requirementId))
    .where(eq(issues.id, issueId));
  if (row?.status !== 'agreed' || row.currentRevision === null) return;
  const revision = row.currentRevision;
  const liveBuild = await liveBuildOfRequirement(row.projectId, row.id);
  const { delivery } = await deliveryIn(db, row.projectId, row, liveBuild);
  if (delivery.phase !== 'delivered') return;
  await db.transaction((tx) =>
    emitEvent(tx, 'requirement.delivered', {
      projectId: row.projectId,
      requirementId: row.id,
      key: requirementKey(row.reqSeq),
      title: row.title,
      revision,
    }),
  );
}

export function registerRequirementDelivery(): void {
  consume('issue.transitioned', {
    name: 'requirement-delivery',
    handle: async (p) => {
      // A linked issue closed or dropped can be the move that completes the delivery.
      if (!(ISSUE_TERMINAL_STATUSES as readonly string[]).includes(p.to)) return;
      await noticeDelivered(p.id);
    },
  });
}
