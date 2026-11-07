/**
 * Each row's attention group as a dependent reads it (ISS-1072): a dependent waits on a blocker that
 * moves or waits its turn and is stuck only behind a stuck one (`standing-held.ts:blockerTurn`). A
 * live blocker outside the rows asked for is read by its own standing, through `readOutside`; where
 * none is given (the read has followed blockers as far as it goes) that blocker reads unread. A
 * blocker's group may turn on its own blocker's, so the rows are settled in passes until none changes.
 */

import type { IssueAttentionGroup } from '@forge/contracts/issue-standing';
import { deriveIssueStanding, type IssueStandingInput } from './standing.js';

type Groups = Map<string, IssueAttentionGroup>;

export async function settledGroups(
  rows: readonly (readonly [string, IssueStandingInput])[],
  readOutside: ((ids: string[]) => Promise<ReadonlyMap<string, IssueAttentionGroup>>) | null,
): Promise<Groups> {
  const asked = new Set(rows.map(([id]) => id));
  const outside = [
    ...new Set(
      rows.flatMap(([, i]) =>
        i.blockedBy.filter((b) => b.holds && !asked.has(b.id)).map((b) => b.id),
      ),
    ),
  ];
  const groups: Groups = new Map(
    outside.length > 0 && readOutside ? await readOutside(outside) : [],
  );
  for (let pass = 0; pass <= rows.length; pass++) {
    let changed = false;
    for (const [id, input] of rows) {
      const group = deriveIssueStanding(input, groups).attentionGroup;
      if (groups.get(id) !== group) {
        groups.set(id, group);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return groups;
}
