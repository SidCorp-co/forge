import { actorFor, can, projectResource } from '../permissions/index.js';
import type { WorkflowWriter } from './service.js';

/**
 * The acts the page offers beside deciding, each by the permission core's own route checks:
 * editing a design takes `workflow-designs.write` (`service.ts:assertWriter`), drafting a
 * requirement from it `project.write` (`requirements/service.ts`).
 */
export async function viewerActs(viewer: WorkflowWriter | null, projectId: string) {
  if (!viewer) return { canWrite: false, canDraftRequirement: false };
  const resource = projectResource(projectId);
  const [canWrite, canDraftRequirement] = await Promise.all([
    can(actorFor(viewer.userId, viewer.agency), 'workflow-designs.write', resource),
    can(actorFor(viewer.userId), 'project.write', resource),
  ]);
  return { canWrite, canDraftRequirement };
}
