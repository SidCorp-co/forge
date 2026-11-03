// What the workflow routes declare (REQ-12 BC-20, ISS-824): the door permissions on the path's
// project, and the rules refused by name in the WORKFLOW_REFUSED envelope, which have no floor.

import {
  requiresByRule,
  requiresOnParam,
  requiresOnResolved,
  requiresPublic,
} from '../permissions/index.js';

export const READ = requiresOnParam('project.read', 'id');
/** project.read on the path's project, checked by the service once the handler has refused a non-uuid id. */
export const READ_ON_PATH_PROJECT = requiresOnResolved(
  'project.read',
  'the project the path names, once the handler has refused an id that is no uuid',
);

/** The kernel's built-in diagram templates: the vocabulary a design is checked against, no project's data. */
export const CATALOGUE_IS_PUBLIC = requiresPublic(
  "the built-in workflow templates carry no project's data and are read with no credential",
);
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
