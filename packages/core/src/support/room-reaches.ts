// What a room's agent was given and read, kept in the run-context record every master and run
// already writes to (ISS-1251 c3): the lessons and capability cards its turn's brief carried, and
// what its read acts returned (knowledge searched, reference sources, its guide). The record is the
// room session's, so the capabilities page reads it under `room:<kind>` beside `session:<kind>`.
// Every write is off the act's path: a failed one is counted by the recorder, never the act's.

import type { RunContextHow, RunContextSource } from '@forge/contracts/run-context';
import { selectLessonEntries } from '../knowledge/index.js';
import { lessonNamedIn } from '../lessons/index.js';
import {
  digestOf,
  type Found,
  recordCarriedLater,
  recordSessionReached,
  sourcesOf,
} from '../run-context/index.js';
import { actDoor, mapLine, SUPPORT_ACT_CARDS, type SupportAction } from './act-cards.js';
import type { RoomRow } from './store.js';

/** Records what one of the room agent's read acts returned, against the room's session. */
export function noteRoomReached(
  room: Pick<RoomRow, 'sessionId'>,
  projectId: string,
  how: Exclude<RunContextHow, 'prompt'>,
  found: Found,
): void {
  if (!room.sessionId) return;
  recordSessionReached({ projectId, sessionId: room.sessionId }, how, sourcesOf(found));
}

/**
 * The room act cards `text` carries: each whose map line (`act-cards.ts:mapLine`, its card's lead
 * situation) the composed brief holds, at the text of its card. Read off the text, so the record is
 * of what the agent was given.
 */
export function cardsCarriedIn(text: string): RunContextSource[] {
  return (Object.keys(SUPPORT_ACT_CARDS) as SupportAction[])
    .filter((act) => text.includes(mapLine(act)))
    .map((act) => ({
      kind: 'capability' as const,
      ref: actDoor(act),
      revision: digestOf(JSON.stringify(SUPPORT_ACT_CARDS[act])),
    }));
}

/**
 * Records what a turn's composed brief carried (`dispatch.ts:handTurn`): each lesson its lessons map
 * names and each room act card whose map line it holds. `carried` is the brief and lessons alone, never the
 * members' messages, so a member naming an act is no card the turn was given.
 */
export function noteTurnCarried(room: RoomRow, sessionId: string, carried: string): void {
  if (!carried) return;
  recordCarriedLater({ projectId: room.projectId, sessionId }, async () => {
    const lessons = await selectLessonEntries(room.projectId);
    return {
      issueIds: [],
      sources: [
        ...lessons
          .filter((l) => lessonNamedIn(carried, l.slug))
          .map((l) => ({
            kind: 'lesson' as const,
            ref: l.slug,
            revision: digestOf(l.sentence),
          })),
        ...cardsCarriedIn(carried),
      ],
    };
  });
}
