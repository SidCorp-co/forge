// The note a run that may not act writes without a model (REQ-48 cost guard): when the day's budget
// is spent, the item's note says so, through the note door like any other, so no model is spent to
// say that no model may be. Its claims are the standing's own fields, so the door's vet holds.

import { basisFieldsOf, type ItemStanding, type StewardCite } from '@forge/contracts/steward';
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

export function budgetNoteBody(run: RunRow, standing: ItemStanding) {
  const fields = basisFieldsOf(standing);
  const cites: StewardCite[] = [citeOf(run.subjectKey)];
  if (standing.waitingOn.ref && standing.waitingOn.ref !== run.subjectKey) {
    cites.push(citeOf(standing.waitingOn.ref));
  }
  return {
    lines: [
      `The steward's daily budget for this project is spent, so it did not act on ${run.trigger} here.`,
      'It acts again after midnight UTC; until then this item waits on whoever its standing names.',
    ],
    cites,
    claims: {
      group: fields.group,
      waitingKind: fields.waitingKind,
      ref: fields.ref,
      stuck: fields.stuckCode !== null,
      stuckCode: fields.stuckCode,
      dueAt: fields.dueAt,
    },
    basis: standing.basis,
    runId: run.id,
  };
}

/** Write the budget note on a requirement or feedback item; an issue takes no note. */
export async function budgetNote(run: RunRow, standing: ItemStanding | null): Promise<void> {
  if (run.subjectKind === 'issue' || !standing) return;
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
