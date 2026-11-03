// What the workflow routes declare (REQ-12 BC-20, ISS-824): the door permissions on the path's
// project, and the rules refused by name in the WORKFLOW_REFUSED envelope, which have no floor.

import { requiresByRule, requiresOnParam } from '../permissions/index.js';

export const READ = requiresOnParam('project.read', 'id');
export const WRITE = requiresOnParam('project.write', 'id');
export const DESIGN = requiresOnParam('workflow-designs.write', 'id');

/** Deciding a revision and re-pinning designs onto an approved base, as design_decide declares. */
export const DESIGN_APPROVER = requiresByRule(
  'workflows/design-service.ts:approverRefusalFor',
  "the design's approver rule decides who approves, returns or re-pins onto a revision",
);

export const OBSERVATION_WRITE = requiresByRule(
  'workflows/observations.ts:writeObservation',
  'workflow-observations.write, refused by name in the WORKFLOW_REFUSED envelope',
);
