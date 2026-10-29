// The ports of the domains a steward act reaches through, filled once at boot by the process entry
// (ADR 0008): the steward calls each door through this app as the project's steward account, wakes
// a master over the socket and reads whom that master acts as (REQ-48 BC-12, ISS-607); a suggestion
// reads whether its project's steward is held; and a mockup's correction is read through the mockup's
// own view, never its table (REQ-50 BC-1); and a release's page reads who names it through the
// steward's addressee (ISS-590).

import { masterTakesWait } from './development/index.js';
import { provideLessonsPorts } from './lessons/index.js';
import { masterAccountsOf } from './master-accounts.js';
import { getMockupAs } from './mockups/index.js';
import { runningBuildObserved, stewardReleaseFacts } from './release-batch/index.js';
import { provideReleasePagePorts } from './release-page/index.js';
import { heldStewardOf, provideStewardPorts, releaseNamerOf } from './steward/index.js';
import { provideSuggestionsPorts } from './suggestions/index.js';
import { wakeMastersForSteward } from './ws/index.js';

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
