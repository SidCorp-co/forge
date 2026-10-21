/**
 * Who owns a requirement: one member of the project, or nobody (REQ-48 BC-5). A requirement nobody
 * owns reads stuck `no_owner`, and the steward names its author as owner through this door. An owner
 * who is not a member is refused by name, since nothing the requirement owes would reach them.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { actorFor, permissionFactsOf, projectResource, requireCan } from '../permissions/index.js';
import { type RequirementActor, rowIn } from './read.js';
import { answer, inTx, lockRequirements, type RequirementOutcome } from './write-tx.js';

export async function setRequirementOwner(input: {
  projectId: string;
  ref: string;
  actor: RequirementActor;
  owner: string | null;
}): Promise<RequirementOutcome> {
  const { projectId, actor, owner } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  if (owner !== null && (await permissionFactsOf(owner, projectId)).role === null) {
    return {
      ok: false,
      refusals: [
        {
          code: 'REQUIREMENT_OWNER_NOT_MEMBER',
          path: '/owner',
          detail: `user ${owner} is not a member of this project, so it cannot own a requirement here; name a member from GET /api/projects/${projectId}/members, or null for no owner`,
        },
      ],
    };
  }
  const refusals = await inTx(async (tx) => {
    await lockRequirements(tx, projectId);
    await tx
      .update(requirements)
      .set({ ownerId: owner, updatedAt: sql`now()` })
      .where(eq(requirements.id, row.id));
    return null;
  });
  return answer(projectId, row.id, actor, refusals);
}
