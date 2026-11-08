/**
 * The one state a requirement row and a feedback row are grouped under (FB-583, owner 2026-11-08,
 * `@forge/contracts/standing:ATTENTION_GROUPS`). A slice's own rules first read a turn in its working
 * groups (an act the viewer owes, work moving, a wait on someone else, held, put aside, ended); this
 * maps that turn, with its times, to the shared vocabulary, so the list, the record and every count
 * read the one group and no screen derives its own.
 */

import type { AttentionGroup, WaitingOn } from '@forge/contracts/standing';
import { actClassOf } from './standing-act-class.js';

/** The groups a slice's turn rules read before the shared vocabulary; `stuck` is the stuck rule's (`standing-times.ts:withTimes`). */
export type TurnGroup = 'needs_you' | 'moving' | 'waiting' | 'stuck' | 'deferred' | 'done';

export interface AttentionFacts {
  /** An issue carrying the row is in progress, or a run holds it now. */
  running: boolean;
  /** It ended without delivering (a requirement dropped or refused, a feedback item declined): never Done. */
  dropped: boolean;
}

/**
 * First that holds wins: the viewer owes it → Needs you; ended → Done, or Dropped where it ended
 * without delivering; put aside → Deferred; the stuck rule holds (past its due, or nobody serves it,
 * `times.stuck` names which) → Overdue; an issue or a run works on it → Running; the master's queue,
 * which has no clock → Queued; any other wait → Waiting on others.
 */
export function attentionGroupOf(
  group: TurnGroup,
  w: Pick<WaitingOn, 'kind' | 'says'>,
  f: AttentionFacts,
): AttentionGroup {
  if (group === 'needs_you') return 'needs_you';
  if (group === 'done') return f.dropped ? 'dropped' : 'done';
  if (group === 'deferred') return 'deferred';
  if (group === 'stuck') return 'overdue';
  if (f.running) return 'running';
  if (actClassOf(w) === 'queue') return 'queued';
  return 'waiting';
}
