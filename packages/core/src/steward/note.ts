// The note's body, built by code from the standing a run read (REQ-48 BC-7, BC-8): its claims and
// basis are that standing's own fields and its cites name the item and the record the wait names, so
// the door's vet compares the standing with itself and a note fails only on its words or a moved
// standing. A model writes the two lines alone (`door-writes.ts:NOTE`). The note the runaway guard
// writes without a model, on an act it refused for repeating (`policy.ts`), is built the same way.

import {
  basisFieldsOf,
  claimsOf,
  type ItemStanding,
  STEWARD_NOTE_CITES_MAX,
  type StewardAct,
  type StewardCite,
  type StewardNoteWrite,
  type StewardTrigger,
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

/**
 * What each handoff is, in the words a person reads on the item (ISS-1137): a note names what waited,
 * never the outbox event that carried it (`feedback.filed`). A trigger added without its words fails
 * the typecheck here rather than printing its event name.
 */
export const TRIGGER_WORDS: Record<StewardTrigger, string> = {
  'requirement.agreed': 'the agreed requirement',
  'breakdown.proposed': 'the proposed breakdown',
  'feedback.filed': 'the new feedback',
  'standing.stuck': 'the stuck work',
  'release.asked': 'the release asked for',
  'release.held': 'the held release',
  'release.shipped': 'the shipped release',
  'standing.changed': 'the change in where this stands',
};

/** What each act is, in the words a person reads on the item: never the act's own id. */
export const ACT_WORDS: Record<StewardAct, string> = {
  note: 'its note',
  intake_check: 'the intake check',
  breakdown_check: 'the breakdown check',
  triage_draft: 'the triage draft',
  stuck_diagnosis: 'the diagnosis of what is stuck',
  output_check: 'the output check',
  release_followthrough: 'the check of the shipped release',
};

/** What the runaway guard refused, as the steward's note on an item with an open standing. */
export function repeatedNoteBody(
  run: RunRow,
  standing: ItemStanding,
  repeated: { act: StewardAct; count: number },
): StewardNoteWrite {
  return noteWriteOf(
    standing,
    [
      `The steward took ${ACT_WORDS[repeated.act]} here ${repeated.count} times while where this stands did not move, so it stopped repeating it.`,
      'It acts again once this item moves; until then the item waits on whoever its standing names.',
    ],
    [],
    run.id,
  );
}

/** The same said on an issue with no open standing to hold a note: as a comment on the issue. */
export function repeatedCommentBody(
  run: RunRow,
  repeated: { act: StewardAct; count: number },
): { intent: 'note'; body: string } {
  return {
    intent: 'note',
    body: [
      `The steward took ${ACT_WORDS[repeated.act]} on ${run.subjectKey} ${repeated.count} times while the issue did not move, so it stopped repeating it.`,
      'It acts again once the issue moves.',
    ].join('\n\n'),
  };
}

/**
 * Say on the run's item that the runaway guard refused its act (`policy.ts:admitRun`): the steward's
 * note where the item has an open standing, else a comment on the issue. The run's own failure names
 * the refusal whatever this write answers.
 */
export async function repeatedNote(
  run: RunRow,
  standing: ItemStanding | null,
  repeated: { act: StewardAct; count: number },
): Promise<void> {
  const call = standing
    ? {
        method: 'PUT' as const,
        path: `/api/projects/${run.projectId}/steward-notes/${run.subjectKind}/${run.subjectKey}`,
        body: repeatedNoteBody(run, standing, repeated),
      }
    : run.subjectKind === 'issue'
      ? {
          method: 'POST' as const,
          path: `/api/issues/${run.subjectId}/comments`,
          body: repeatedCommentBody(run, repeated),
        }
      : null;
  if (!call) return;
  const credential = await mintStewardCredential({
    projectId: run.projectId,
    stewardId: await stewardAccountOf(run.projectId),
    acts: ['note'],
    ttlMs: STEWARD_TURN_TTL_MS,
  });
  try {
    const answer = await callDoor(call, bearer(credential.token));
    if (!answer.ok) {
      logger.warn(
        {
          runId: run.id,
          subject: run.subjectKey,
          status: answer.status,
          body: answer.text.slice(0, 300),
        },
        'steward: the repeated-act note was refused; the run itself names STEWARD_ACT_REPEATED',
      );
    }
  } finally {
    await credential.revoke();
  }
}
