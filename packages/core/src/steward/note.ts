// The note's body, built by code from the standing a run read (REQ-48 BC-7, BC-8): its claims and
// basis are that standing's own fields and its cites name the item and the record the wait names, so
// the door's vet compares the standing with itself and a note fails only on its words or a moved
// standing. A model writes the two lines alone (`door-writes.ts:NOTE`). The note a run that may not
// act writes without a model (the cost guard) is built the same way.

import {
  basisFieldsOf,
  claimsOf,
  type ItemStanding,
  STEWARD_NOTE_CITES_MAX,
  type StewardCite,
  type StewardNoteWrite,
} from '@forge/contracts/steward';
import { logger } from '../lib/logger.js';
import { stewardAccountOf } from './account.js';
import { mintStewardCredential, STEWARD_TURN_TTL_MS } from './credential.js';
import { bearer, callDoor } from './door-call.js';
import type { RunRow } from './runs-store.js';

/** What a record a wait names is, by its key: a requirement, a feedback item, a release or an issue. */
function citeOf(ref: string): StewardCite {
  if (/^REQ-\d+$/.test(ref)) return { kind: 'requirement', ref };
  if (/^FB-\d+$/.test(ref)) return { kind: 'feedback', ref };
  if (/^\d+\.\d+\.\d+/.test(ref)) return { kind: 'release', ref };
  return { kind: 'issue', ref };
}

/**
 * A note on `standing` saying `lines`: the claims and basis copied from it, the item and the record
 * its wait names cited first, then `more` (the records the run wrote or read), each cited once.
 */
export function noteWriteOf(
  standing: ItemStanding,
  lines: readonly string[],
  more: readonly StewardCite[],
  runId: string | null,
): StewardNoteWrite {
  const own: StewardCite[] = [{ kind: standing.subject.kind, ref: standing.subject.key }];
  if (standing.waitingOn.ref && standing.waitingOn.ref !== standing.subject.key) {
    own.push(citeOf(standing.waitingOn.ref));
  }
  const seen = new Set<string>();
  const cites = [...own, ...more].filter((c) => {
    const at = `${c.kind}:${c.ref}`;
    if (seen.has(at)) return false;
    seen.add(at);
    return true;
  });
  return {
    lines: [...lines],
    cites: cites.slice(0, STEWARD_NOTE_CITES_MAX),
    claims: claimsOf(basisFieldsOf(standing)),
    basis: standing.basis,
    runId,
  };
}

export function budgetNoteBody(run: RunRow, standing: ItemStanding): StewardNoteWrite {
  return noteWriteOf(
    standing,
    [
      `The steward's daily budget for this project is spent, so it did not act on ${run.trigger} here.`,
      'It acts again after midnight UTC; until then this item waits on whoever its standing names.',
    ],
    [],
    run.id,
  );
}

/** Write the budget note on the run's item: a requirement, a feedback item or an issue. */
export async function budgetNote(run: RunRow, standing: ItemStanding | null): Promise<void> {
  if (!standing) return;
  const credential = await mintStewardCredential({
    projectId: run.projectId,
    stewardId: await stewardAccountOf(run.projectId),
    acts: ['note'],
    ttlMs: STEWARD_TURN_TTL_MS,
  });
  try {
    const answer = await callDoor(
      {
        method: 'PUT',
        path: `/api/projects/${run.projectId}/steward-notes/${run.subjectKind}/${run.subjectKey}`,
        body: budgetNoteBody(run, standing),
      },
      bearer(credential.token),
    );
    if (!answer.ok) {
      logger.warn(
        {
          runId: run.id,
          subject: run.subjectKey,
          status: answer.status,
          body: answer.text.slice(0, 300),
        },
        'steward: the budget note was refused; the run itself says budget_spent',
      );
    }
  } finally {
    await credential.revoke();
  }
}
