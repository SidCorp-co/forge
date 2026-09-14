/**
 * Where a message is screened, and what happens when it cannot pass.
 *
 * This is a separate table from `cells.ts` because one cell is screened at
 * doors whose lifecycles differ: `role:ask` is read at `question-ask`, where the
 * agent is still on the line, and at `question-delivery`, which posts into a
 * room minutes later with nobody left to ask again; `public:report` is read at
 * three doors that can repair 1, 1 and 0 times. A repair count on the cell would
 * have to be right for all of them and can only be right for one (ISS-997).
 */

import type { Audience, CellId, DoorId, DoorPolicy, Intent } from './contract.js';

// cm:guard the whole set is asserted by `doors.test.ts`, not a sample: a door added here without a policy, or a policy pointing at a cell that does not exist, fails by name rather than defaulting to something plausible.
export const DOORS: readonly DoorPolicy[] = [
  {
    id: 'comment-write',
    cell: 'role:report',
    ending: 'refusal',
    why: 'a synchronous write with the agent on the line — nothing is posted for it, so telling it what broke IS the answer, and substituting a fallback here would be us writing words the agent did not write',
  },
  {
    id: 'question-ask',
    cell: 'role:ask',
    ending: 'refusal',
    why: 'the same, and the reason the round is screened here rather than only at delivery: refused to its author, a bad round never becomes owed and unpostable',
  },
  {
    id: 'question-delivery',
    cell: 'role:ask',
    ending: 'refusal',
    why: 'it posts into a room and still refuses, because a question round is the AGENT asking and nobody is waiting on it — the only text the round has is the text that failed, and a stand-in would announce that a decision is waiting while hiding what it is (ISS-978)',
  },
  {
    id: 'chat-sync',
    cell: 'public:report',
    ending: 'fallback',
    repairs: 1,
    why: 'somebody asked and is waiting; exactly one corrective retry, because each is a full model turn inside HANDLE_TIMEOUT_MS and a model that failed the guard twice does not converge on a third',
  },
  {
    id: 'escalation-synthesis',
    cell: 'public:report',
    ending: 'fallback',
    repairs: 1,
    why: 'the same, and it CAN repair: the synthesis runs its own model turn, so there is something to ask again — which is why it no longer falls back at once',
  },
  {
    id: 'agent-chat-completion',
    cell: 'public:report',
    ending: 'fallback',
    repairs: 0,
    why: 'somebody is waiting, so a fallback is owed — but the runner session whose final message this carries has already ended, so there is no turn to ask again and a declared budget would be one this door could never spend',
  },
];

const byId = new Map<DoorId, DoorPolicy>(DOORS.map((d) => [d.id, d]));

export function doorPolicy(id: DoorId): DoorPolicy {
  const d = byId.get(id);
  if (!d) throw new Error(`messaging: no door named "${id}"`);
  return d;
}

/** The pair a door screens at, read off its own row. */
// cm:guard the split lives here and nowhere else: a caller that re-derives the pair from a door — or worse, names an audience and an intent of its own beside one — is how a surface comes to be screened against a cell its door does not declare, which is the shape ISS-997 found the comment door in (ISS-1002).
// cm:guard it cuts at the LAST colon, because `Audience` is an open string and nothing forbids one containing a colon: cutting at the first turns `internal:operator:report` into audience `internal` and intent `operator`, which names no cell, so that door would fail closed on every message it screened and say only that the pair is unknown.
export function doorCell(id: DoorId): { audience: Audience; intent: Intent } {
  return cellPair(doorPolicy(id).cell);
}

/** The same carve, over a cell id — so the rule above can be read against one. */
export function cellPair(cell: CellId): { audience: Audience; intent: Intent } {
  const cut = cell.lastIndexOf(':');
  return { audience: cell.slice(0, cut), intent: cell.slice(cut + 1) as Intent };
}
