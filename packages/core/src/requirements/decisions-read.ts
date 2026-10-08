import type { RequirementDecisionsResponse } from '@forge/contracts/requirements';
import { listDecisionsAs } from '../comments/index.js';
import { db } from '../db/client.js';
import type { ReadDoor } from '../feedback/index.js';
import { dataPolicyOf, egressReading } from '../lib/data-egress.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { answerViewsOf } from './clarity.js';
import { type RequirementActor, rowIn } from './read.js';

/** GET …/requirements/:req/decisions: its decisions and those on its issues, and the answers beside them. */
export async function readRequirementDecisionsAs(
  viewer: RequirementActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
): Promise<RequirementDecisionsResponse> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, ref);
  const withheld = egressReading(
    await dataPolicyOf(projectId),
    { agency: viewer.agency, providerBound: door.providerBound },
    'requirement.clarification',
  ).withhold;
  const [listed, answers] = await Promise.all([
    listDecisionsAs(viewer, projectId, { requirement: row.id, limit: 200 }, door),
    answerViewsOf(db, row.id, withheld),
  ]);
  return { decisions: listed.decisions, answers };
}
