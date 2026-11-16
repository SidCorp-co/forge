// The issue list's text filter as a filter of the find door (ISS-1256): `GET /api/projects/:id/issues/search?q=`,
// the issue list's `search` and `issues.list`'s all read the issues the door's issue filter keeps,
// in its order, so "run slots" lists the issues `POST /find` with `type: ["issue"]` answers, never a
// substring match of its own. The list's other filters narrow that set; its `sort`, where one is
// sent, orders it.

import { FIND_LIMIT } from '@forge/contracts/find';
import { runFind } from './service.js';

/** How many issues one text filter answers at most: the door's own most, so the two read alike. */
export const ISSUE_FILTER_LIMIT = FIND_LIMIT.max;

/** The ids of the project's issues the door's issue filter keeps for `q`, best first. */
export async function issueIdsThroughFind(projectId: string, q: string): Promise<string[]> {
  const { kept } = await runFind({
    projectId,
    projectIds: [projectId],
    query: { q, type: ['issue'], limit: ISSUE_FILTER_LIMIT },
    // a list filter is read for no one person: the issues it keeps are the project's either way
    reader: 'own-project',
    askedBy: 'agent',
    filterOnly: true,
  });
  return kept.map((c) => c.ref);
}
