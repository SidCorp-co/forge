// The ports of the domains a steward act reaches through, filled once at boot by the process entry
// (ADR 0008): the steward calls each door through this app as the project's steward account, wakes
// a master over the socket and reads whom that master acts as (REQ-48 BC-12, ISS-607); a suggestion
// reads whether its project's steward is held; and a release's page reads who names it through the
// steward's addressee (ISS-590). What a lesson reads (a mockup, a room writer, a card) is wired
// beside it in `lessons-ports.ts`, so neither file coordinates every module a steward touches.

import { masterTakesWait } from './development/index.js';
import { doorCatalog } from './lib/door-catalog.js';
import { masterAccountsOf } from './master-accounts.js';
import { readPiles } from './metrics/index.js';
import {
  holdingReleaseOf,
  masterTakesReleaseAct,
  releaseHoldingActOf,
  runningBuildObserved,
  stewardReleaseFacts,
} from './release-batch/index.js';
import { provideReleasePagePorts } from './release-page/index.js';
import { heldStewardOf, provideStewardPorts, releaseNamerOf } from './steward/index.js';
import { provideSuggestionsPorts } from './suggestions/index.js';
import { judgeSelfAudit, keepSelfAudit } from './support/index.js';
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
    // a release act by the one rule read with what the release carries, any other by Needs you's (ISS-1058)
    masterTakes: async (projectId, act) =>
      (await masterTakesReleaseAct(projectId, act)) ?? masterTakesWait(projectId, act),
    releaseHoldingAct: (_projectId, issueId) => releaseHoldingActOf(issueId),
    holdingRelease: holdingReleaseOf,
    piles: (projectId) => readPiles(projectId, doorCatalog()),
    // the steward's audit of its own run, in the store and shape every agent's goes to (ISS-1251)
    keepSelfAudit: async (a) => {
      const judged = judgeSelfAudit('steward', a.failed, a.missed);
      if (!judged.ok) return judged;
      await keepSelfAudit({
        projectId: a.projectId,
        agent: 'steward',
        output: { kind: 'steward_run', ref: a.runId },
        byUserId: a.userId,
        agency: 'agent',
        judged: judged.value,
        item: { ...a.subject, title: null },
      });
      return { ok: true };
    },
  });
  provideSuggestionsPorts({ stewardOf: heldStewardOf });
  provideReleasePagePorts({ releaseNamer: releaseNamerOf });
}
