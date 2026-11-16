// Whether a project's steward is on, and the one bound on what it does (ISS-1255): the runaway guard.
// The steward spends no daily budget. Its runner jobs are runs on its project's box like any other,
// given a slot by `devices/run-slots.ts:slotsFor` (`dispatch.ts`); its gateway turns are bounded per
// item instead: the same act on the same item, its standing unmoved, runs `STEWARD_ACT_REPEAT_LIMIT`
// times and is then refused STEWARD_ACT_REPEATED until the standing moves, said on the item.

import type { StewardAct } from '@forge/contracts/steward';
import { readProjectDocument } from '../project-config/index.js';
import { markStarted, REPEATED_CODE, repeatsOnBasis } from './runs-store.js';

export interface StewardStance {
  enabled: boolean;
}

/** The project's steward policy: on unless its document says `enabled: false`. */
export async function stewardStanceOf(projectId: string): Promise<StewardStance> {
  const policy = (await readProjectDocument(projectId))?.document.steward;
  return { enabled: policy?.enabled ?? true };
}

/** How many times one act runs on one item whose standing has not moved; the next is refused. */
export const STEWARD_ACT_REPEAT_LIMIT = 5;

/** Why a run may not take its acts now: the steward is off, or one act repeats without a state change. */
export type Admission =
  | { skip: 'steward_off' }
  | { repeated: { act: StewardAct; count: number; basis: string } };

/** The refusal a repeated act ends its run with, naming the item, the act and the count. */
export function repeatedRefusal(
  run: { subjectKey: string },
  repeated: { act: StewardAct; count: number; basis: string },
): string {
  return (
    `${REPEATED_CODE}: ${repeated.act} on ${run.subjectKey} already ran ${repeated.count} times ` +
    `on standing ${repeated.basis} without it moving (the limit is ${STEWARD_ACT_REPEAT_LIMIT}); ` +
    'the steward takes it again once the standing moves'
  );
}

/**
 * Take the claimed run up, or say why it may not take `acts` on the standing `basis`: the steward is
 * off, or an act already ran its limit on that basis. A run with no basis (an item with no open
 * standing) has no state to compare and is never held as a repeat.
 */
export async function admitRun(
  run: { id: string; projectId: string; subjectKind: string; subjectId: string },
  acts: readonly StewardAct[],
  basis: string | null,
): Promise<Admission | null> {
  if (!(await stewardStanceOf(run.projectId)).enabled) return { skip: 'steward_off' };
  if (basis !== null) {
    for (const act of acts) {
      const count = await repeatsOnBasis({ kind: run.subjectKind, id: run.subjectId }, act, basis);
      if (count >= STEWARD_ACT_REPEAT_LIMIT) return { repeated: { act, count, basis } };
    }
  }
  await markStarted(run.id);
  return null;
}
