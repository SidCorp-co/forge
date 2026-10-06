/**
 * Which agreed requirements owe their project master a breakdown (workflow requirement-to-delivery
 * steps `delivery` and `stalled`): the standing's open breakdown task, due or overdue. The box
 * carrying the master reads it on every sweep, so an agree is master work whether or not its
 * requirement.agreed wake was heard, and an overdue one is shown on the next pass.
 */

import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { standingsOf } from './standing-read.js';

export interface OwedBreakdown {
  requirementId: string;
  key: string;
  title: string;
  revision: number;
  dueAt: string;
  overdue: boolean;
}

export async function owedBreakdowns(projectId: string): Promise<OwedBreakdown[]> {
  const rows = await db
    .select({
      id: requirements.id,
      projectId: requirements.projectId,
      reqSeq: requirements.reqSeq,
      title: requirements.title,
      status: requirements.status,
      currentRevision: requirements.currentRevision,
      ownerId: requirements.ownerId,
      updatedAt: requirements.updatedAt,
    })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), eq(requirements.status, 'agreed')))
    .orderBy(requirements.reqSeq);
  const standings = await standingsOf(projectId, rows, null);
  return rows.flatMap((r) => {
    const task = standings.get(r.id)?.tasks.find((t) => t.kind === 'breakdown');
    if (task?.kind !== 'breakdown') return [];
    return [
      {
        requirementId: r.id,
        key: requirementKey(r.reqSeq),
        title: r.title,
        revision: task.revision,
        dueAt: task.dueAt,
        overdue: task.overdue,
      },
    ];
  });
}
