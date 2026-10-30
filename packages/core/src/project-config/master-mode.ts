// How a project's resident master works (`@forge/contracts/master-mode`): `direct` where its project
// document's gate profile is `yolo` and it delivers fast, else `dispatch`. A project with no document
// has the standard profile, so its master dispatches.

import { type MasterMode, masterModeOf } from '@forge/contracts/master-mode';
import { readProjectDocument } from './service.js';

export async function readMasterMode(projectId: string): Promise<MasterMode> {
  return masterModeOf((await readProjectDocument(projectId))?.document);
}
