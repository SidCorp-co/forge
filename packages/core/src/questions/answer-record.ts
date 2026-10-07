// The record an answer leaves on the issue its question stopped: the answer moved the park (or held
// it) with no comment and no issue event, so a master reading the thread or the events kept
// reporting six answered questions as owner-pending (hop, 2026-10-07). Written in the answer's own
// transaction, by both doors that answer one: a person's answer and a design decision.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { AnswerHold } from '@forge/contracts/questions';
import type { Tx } from '../db/client.js';
import { writeRecordEvent } from '../issues/index.js';

export async function recordAnswerOnIssue(
  tx: Tx,
  args: {
    issueId: string | null;
    questionId: string;
    round: number;
    answer: string;
    by: string;
    agency: ActorAgency;
    hold?: AnswerHold | undefined;
  },
): Promise<void> {
  if (!args.issueId) return;
  const field = (key: string, value: string | undefined) =>
    value === undefined || value === '' ? [] : [{ key, value }];
  await writeRecordEvent(
    {
      issueId: args.issueId,
      actor: { type: 'user', id: args.by, agency: args.agency },
      kind: 'answer',
      contract: 1,
      fields: [
        { key: 'question', value: args.questionId },
        { key: 'round', value: String(args.round) },
        ...field('answer', args.answer),
        ...field('still-waits', args.hold?.reason),
        ...field('blocked-by', args.hold?.blockedBy?.key),
      ],
    },
    tx,
  );
}
