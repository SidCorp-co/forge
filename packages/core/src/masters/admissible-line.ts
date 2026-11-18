// The admissible issues a direct pass is asked to build, named on the pass itself (ISS-1224, extra
// fix). A direct pass is typed with the fixed order and what is owed; the admissible issues moved
// only the digest that decides whether to wake, so ISS-1224, created at `open` through the REST
// API, woke its master for five hours (07:09Z to 12:07Z on 2026-11-12) on passes that never said
// which issue. A dispatching pass reads the board by the dispatch method's wave and is left as it is.
//
// ISS-1297 (FB-720): while every run slot of the project is in use, a build or a pass-over of each
// row was asked every pass, though the box refuses each declare RUN_SLOT_UNAVAILABLE; the line says
// the wait once instead. A row a decision holds never reaches here (`masters/owed.ts:readMasterWork`).

import { readBoxSlotsForView, subagentSlotsOf } from '../devices/index.js';
import { agrees } from '../lib/plural.js';

/** The fields of an admissible issue the line names (`devices/admissible.ts:AdmissibleIssue`). */
export interface AdmissibleNamed {
  issueId: string;
  issueKey: string | null;
  priority: string | null;
}

/** The project's run slots on its master's box now (`devices/run-slots-read.ts:subagentSlotsOf`). */
export interface RunSlotsNow {
  held: number;
  inUse: number;
}

/** The project's run slots on its master's box, read once inside a sweep's read memo. */
export async function runSlotsOf(deviceId: string, projectId: string): Promise<RunSlotsNow> {
  return subagentSlotsOf(await readBoxSlotsForView(deviceId), projectId);
}

/** How many a pass names by key; the rest are counted, never dropped in silence. */
const NAMED = 5;

/** Every slot the project holds is in use, so a run declare is refused RUN_SLOT_UNAVAILABLE now. */
export const slotsFull = (slots: RunSlotsNow): boolean => slots.inUse >= slots.held;

/** The sentence naming the admissible issues in the order to take them; empty when there are none. */
export function admissibleLine(admissible: readonly AdmissibleNamed[], slots: RunSlotsNow): string {
  if (admissible.length === 0) return '';
  const n = admissible.length;
  const them = agrees(n, 'it', 'them');
  const more = n > NAMED ? `, and ${n - NAMED} more after them` : '';
  if (slotsFull(slots)) {
    const keys = admissible.slice(0, NAMED).map((a) => a.issueKey ?? a.issueId);
    return ` ${n} admissible issue${agrees(n, '', 's')} ${agrees(n, 'waits', 'wait')} for a run slot, all ${slots.held} of the project's in use: ${keys.join(', ')}${more}. Build none and record no pass-over for ${them}; the pass after one of your runs closes names ${them} to take.`;
  }
  const named = admissible
    .slice(0, NAMED)
    .map((a) => `${a.issueKey ?? a.issueId} ${a.issueId}${a.priority ? ` (${a.priority})` : ''}`);
  return ` ${n} admissible issue${agrees(n, ' is', 's are')} open for you to build, in the order to take ${them}: ${named.join('; ')}${more}. Take ${them} top-down into the batch, or record on the issue why you pass ${agrees(n, 'it', 'one')} over (a decision with a date to come or a condition holds it off this line).`;
}
