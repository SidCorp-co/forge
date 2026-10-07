/**
 * The served set read for a project (ISS-279): its own contracts' current versions, through the
 * contract-version port, matched by `endpoint-rules.ts`.
 */

import type { FeedbackEndpointView } from '@forge/contracts/feedback';
import { db, type Tx } from '../db/client.js';
import { contractVersionReads } from '../lib/contract-versions.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { servedFrom } from './endpoint-rules.js';

/** What `projectId` serves now: its own contracts' current versions, never another project's. */
export async function servedEndpointsOf(
  projectId: string,
  executor: Tx | typeof db = db,
): Promise<FeedbackEndpointView[]> {
  return servedFrom(await contractVersionReads().currentVersionsOf(executor as Tx, [projectId]));
}

/** `GET /api/projects/:id/feedback/endpoints`: the served set, for a reader of the project. */
export async function servedEndpointsAs(
  viewer: { userId: string },
  projectId: string,
): Promise<FeedbackEndpointView[]> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  return servedEndpointsOf(projectId);
}
