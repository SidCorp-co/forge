// The issue list's text filter (ISS-1256): the issues the find door's issue filter keeps for some
// words, in its order. The door is a read model the issue kernel may not import, so the composition
// root fills this at boot (`work-ports.ts:provideIssueFindPort`).

import { portSlot } from '../lib/port-slot.js';

const slot = portSlot<{
  /** The ids of the project's issues `find/issue-filter.ts:issueIdsThroughFind` keeps for `q`, best first. */
  issueIdsFound: (projectId: string, q: string) => Promise<string[]>;
}>('issues find', 'provideIssueFindPort');
export const provideIssueFindPort = slot.provide;
export const issueIdsFound = slot.port('issueIdsFound');
