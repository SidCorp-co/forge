// The ports of the domains a steward act reaches through, filled once at boot by the process entry
// (ADR 0008): the steward calls each door through this app as the project's steward account, wakes
// a master over the socket and reads whom that master acts as (REQ-48 BC-12, ISS-607); a suggestion
// reads whether its project's steward is held; and a mockup's correction is read through the mockup's
// own view, never its table (REQ-50 BC-1).

import { deviceHolderUserId } from './devices/index.js';
import { provideLessonsPorts } from './lessons/index.js';
import { getMockupAs } from './mockups/index.js';
import { stewardReleaseFacts, stewardReopenRefusal } from './release-batch/index.js';
import { projectDeviceIds } from './runners/index.js';
import { heldStewardOf, provideStewardPorts } from './steward/index.js';
import { provideSuggestionsPorts } from './suggestions/index.js';
import { wakeMastersForSteward } from './ws/index.js';

/** The accounts a project's master acts as: each box serving the project, by its credential's holder. */
async function masterAccountsOf(projectId: string): Promise<string[]> {
  const holders = await Promise.all((await projectDeviceIds(projectId)).map(deviceHolderUserId));
  return [...new Set(holders.filter((h): h is string => h !== null))];
}

export function provideStewardDomainPorts(
  doorFetch: (request: Request) => Promise<Response>,
): void {
  provideStewardPorts({
    doorFetch,
    wakeMasters: wakeMastersForSteward,
    reopenRefusal: stewardReopenRefusal,
    releaseFacts: stewardReleaseFacts,
    masterAccounts: masterAccountsOf,
  });
  provideSuggestionsPorts({ stewardOf: heldStewardOf });
  provideLessonsPorts({
    mockupOf: async (projectId, mockupId, viewer) =>
      (await getMockupAs(viewer, projectId, mockupId)) ?? null,
  });
}
