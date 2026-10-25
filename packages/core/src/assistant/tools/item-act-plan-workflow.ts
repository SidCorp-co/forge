// The workflow adapter of `item-act-plans.ts:planItemAct`: what a design's page offers the asker.

import type { ItemAct } from '@forge/contracts/item-acts';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { projectWorkflows } from '../../db/schema-workflows.js';
import { isUuid } from '../../issues/index.js';
import { actorFor, can, projectResource } from '../../permissions/index.js';
import { readDesignAs } from '../../workflows/index.js';
import { type Asker, found, type ItemActReading, no, offer, unknown } from './item-act-plan-kit.js';

/** A workflow page names its flow or its uuid; the design read takes the uuid. */
async function workflowIdOf(projectId: string, key: string): Promise<string | null> {
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

export async function planWorkflow(act: ItemAct, key: string, at: Asker): Promise<ItemActReading> {
  const writer = { userId: at.userId, agency: 'human' as const };
  const id = await workflowIdOf(at.projectId, key);
  const d = id ? await found(readDesignAs(writer, at.projectId, id)) : null;
  if (!d) return unknown('workflow', key);
  const status = d.status ?? 'draft';
  const base = { key: d.flow, ref: d.workflowId, title: d.flow, from: status };
  if (act === 'workflow.propose') {
    if (status !== 'draft')
      return no(
        'ITEM_ACT_NOT_FROM_STATE',
        `${d.flow}'s design is ${status}, and workflow.propose applies to a draft design; a change is proposed by writing it on the design page.`,
      );
    const writes = await can(
      actorFor(at.userId),
      'workflow-designs.write',
      projectResource(at.projectId),
    );
    if (!writes)
      return no(
        'ITEM_ACT_FORBIDDEN',
        `the person asking does not hold workflow-designs.write, so proposing ${d.flow} is not theirs to press.`,
      );
    return offer({ ...base, revision: d.revision });
  }
  if (d.proposedRevision === null)
    return no(
      'ITEM_ACT_NOT_FROM_STATE',
      `${d.flow}'s design is ${status}, and ${act} applies to a design awaiting its approver.`,
    );
  if (!d.canDecide)
    return no(
      'ITEM_ACT_FORBIDDEN',
      `the person asking may not decide ${d.flow}'s design on this project; its approver can.`,
    );
  return offer({ ...base, revision: d.proposedRevision });
}
