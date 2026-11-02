// What cutting a release declares (REQ-12 BC-20, ISS-824): project.admin, which outside strict the
// project's master holds too, is requireMasterAct's rule; a caller with no role on the project is
// refused at the door by the project.read floor, as requireMasterAct would refuse one anyway.

import { requiresByRule } from '../permissions/index.js';

export const CUTS_BY_MASTER_ACT = requiresByRule(
  'permissions/master-acts.ts:requireMasterAct',
  "project.admin, which outside strict the project's master holds too (REQ-79 r6 BC-17)",
  { permission: 'project.read', param: 'projectId' },
);
