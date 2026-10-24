// The body `POST /api/issues/:id/transition` takes: the one definition its validator reads, its
// published contract is generated from, and every served guide and run prompt is held to, sentence
// by sentence (transition-body.test.ts).

import { checklistsOn } from '@forge/contracts/checklist-registry';
import { moveAnswersInputOf } from '@forge/contracts/checklists';
import { REASON_PARAGRAPH_MAX } from '@forge/contracts/comments';
import { ISSUE_MACHINE, type IssueTransitionRefusalCode } from '@forge/contracts/issue-machine';
import { questionAboutRequestSchema } from '@forge/contracts/questions';
import { z } from 'zod';
import { issueStatuses, waitingKinds } from '../db/schema.js';
import { jsonPointer, type Refusal, RefusalError } from '../lib/refusal.js';
import { awaitsDesignSchema } from './awaits-design-input.js';

export const transitionBodySchema = z
  .object({
    toStatus: z.enum(issueStatuses),
    // the move's one reason field: a key the body does not declare, `note` among them, is refused
    // TRANSITION_FIELD_UNKNOWN rather than read as a reason (ISS-566)
    reason: z.string().trim().min(1).max(REASON_PARAGRAPH_MAX).optional(),
    waitingKind: z.enum(waitingKinds).optional(),
    needs: z.string().trim().min(1).max(2000).optional(),
    awaitsDesign: awaitsDesignSchema.optional(),
    awaitsMerge: z.object({ issueId: z.uuid() }).strict().optional(),
    // what the park's question is about, in the shapes and under the refusal POST /api/questions has
    about: questionAboutRequestSchema.optional(),
    voidQuestions: z.string().max(2000).optional(),
    recovery: z.literal(true).optional(),
    // handed to the kernel as sent: it parses them by the checklist of the edge the move takes,
    // and refuses and records a wrong one exactly as it does a lane move's; the contract publishes
    // the shape that checklist derives
    answers: z
      .unknown()
      .meta(moveAnswersInputOf(checklistsOn(ISSUE_MACHINE)))
      .optional(),
  })
  .strict();

/** Every key the transition body takes; any other is refused TRANSITION_FIELD_UNKNOWN. */
export const TRANSITION_BODY_FIELDS: readonly string[] = Object.keys(transitionBodySchema.shape);

/**
 * A body naming a key the transition does not take is refused by that key, with the keys it takes
 * and where a move's reason goes, rather than with zod's bare "Unrecognized key" at the body's root.
 * Every other fault in the body is named beside it. A body with no unknown key gets the shared answer.
 */
export function refuseUnknownTransitionKeys(issues: readonly z.core.$ZodIssue[]): void {
  const unknown = [
    ...new Set(issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []))),
  ];
  if (unknown.length === 0) return;
  const takes = [...TRANSITION_BODY_FIELDS].sort().join(', ');
  const rows: Refusal[] = [
    ...unknown.map((key) => ({
      code: 'TRANSITION_FIELD_UNKNOWN' satisfies IssueTransitionRefusalCode,
      path: jsonPointer([key]),
      detail: `\`${key}\` is not a field of the transition body, which takes ${takes}; a move's reason goes in \`reason\`.`,
    })),
    ...issues
      .filter((i) => i.code !== 'unrecognized_keys')
      .map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
  ];
  throw new RefusalError(rows, 'BAD_REQUEST');
}
