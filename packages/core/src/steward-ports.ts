// The ports of the domains a steward act reaches through, filled once at boot by the process entry
// (ADR 0008): the steward calls each door through this app as the project's steward account, wakes
// a master over the socket and reads whom that master acts as (REQ-48 BC-12, ISS-607); a suggestion
// reads whether its project's steward is held; and a mockup's correction is read through the mockup's
// own view, never its table (REQ-50 BC-1); and a release's page reads who names it through the
// steward's addressee (ISS-590).

import { masterTakesWait } from './development/index.js';
import { deviceHolderUserId, workspaceHolderUserId } from './devices/index.js';
import { provideLessonsPorts } from './lessons/index.js';
import { getMockupAs } from './mockups/index.js';
import { runningBuildObserved, stewardReleaseFacts } from './release-batch/index.js';
import { provideReleasePagePorts } from './release-page/index.js';
import { projectDeviceIds } from './runners/index.js';
import {
  heldStewardOf,
  type MasterAccounts,
  provideStewardPorts,
  releaseNamerOf,
} from './steward/index.js';
import { provideSuggestionsPorts } from './suggestions/index.js';
import { wakeMastersForSteward } from './ws/index.js';

/**
 * The accounts a project's master acts as: for each box serving the project (one holding a live device
 * credential), the holder of its checkout's credential, which its pane writes under. The device
 * credential's holder is not it: a box paired by a person carries the project's agent in its checkout
 * (ISS-590). A box whose checkout carries no live credential is named unread, never guessed.
 */
export async function masterAccountsOf(projectId: string): Promise<MasterAccounts> {
  const accounts = new Set<string>();
  const unread: string[] = [];
  for (const deviceId of await projectDeviceIds(projectId)) {
    if ((await deviceHolderUserId(deviceId)) === null) continue;
    const holder = await workspaceHolderUserId(deviceId, projectId);
    if (holder === null) unread.push(deviceId);
    else accounts.add(holder);
  }
  return { accounts: [...accounts], unread };
}

export function provideStewardDomainPorts(
  doorFetch: (request: Request) => Promise<Response>,
): void {
  provideStewardPorts({
    doorFetch,
    wakeMasters: wakeMastersForSteward,
    releaseFacts: stewardReleaseFacts,
    runningBuildObserved,
    masterAccounts: masterAccountsOf,
    masterTakes: masterTakesWait,
  });
  provideSuggestionsPorts({ stewardOf: heldStewardOf });
  provideReleasePagePorts({ releaseNamer: releaseNamerOf });
  provideLessonsPorts({
    mockupOf: async (projectId, mockupId, viewer) =>
      (await getMockupAs(viewer, projectId, mockupId)) ?? null,
  });
}
