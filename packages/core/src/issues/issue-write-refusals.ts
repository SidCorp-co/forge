// The refusals the issue create and patch doors share.

import type { IssueUpdateRefusalCode } from '@forge/contracts/issues';
import type { z } from 'zod';
import { BodyInvalidError } from '../body/errors.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import { jsonPointer, type Refusal, RefusalError, refuser } from '../lib/refusal.js';
import { heldTakeRefusal } from './blocked-by.js';
import { isProjectMember } from './read-service.js';

export const refuseUpdate = refuser<IssueUpdateRefusalCode>('ISSUE_UPDATE_REFUSED');

export async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  if (!(await isProjectMember(projectId, assigneeId))) {
    throw refuseUpdate(
      'ASSIGNEE_NOT_MEMBER',
      'the assignee is not a member of this project; assign someone who is',
      '/assigneeId',
    );
  }
}

/** A create or patch failure as the HTTP answer: a body refusal, a held take, or itself. */
export function toHttpCreateError(err: unknown): unknown {
  if (err instanceof BodyInvalidError) return bodyInvalidHttp(err);
  return heldTakeRefusal(err) ?? err;
}

const STATUS_KEYS = new Set(['status', 'toStatus']);

const bodyWideRefinement = (i: z.core.$ZodIssue) => i.code === 'custom' && i.path.length === 0;

/**
 * The PATCH body's answer where it names a status: PATCH writes an issue's fields, and its status is
 * a state-machine move, so the key is refused naming the route that makes it rather than as one more
 * unrecognised key. Every other fault in the body is named beside it, except the body-wide
 * refinements, which read the body with its unknown keys already stripped and so would say it names
 * nothing. A body naming no status gets the shared answer.
 */
export function patchBodyAnswer(result: { success: boolean; error?: z.core.$ZodError }): void {
  if (result.success || !result.error) return;
  const issues = result.error.issues;
  const unknown = issues.flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []));
  const status = unknown.filter((k) => STATUS_KEYS.has(k));
  if (status.length === 0) return;
  const rows: Refusal[] = [
    ...status.map((key) => ({
      code: 'STATUS_MOVES_BY_TRANSITION' satisfies IssueUpdateRefusalCode,
      path: jsonPointer([key]),
      detail: `\`${key}\` is not a field PATCH writes: an issue's status is a state-machine move, made by POST /api/issues/:id/transition with { toStatus, reason } (and waitingKind, needs for a park). Nothing in this body was written.`,
    })),
    ...unknown
      .filter((k) => !STATUS_KEYS.has(k))
      .map((key) => ({
        code: 'BAD_REQUEST',
        path: jsonPointer([key]),
        detail: `\`${key}\` is not a field of an issue`,
      })),
    ...issues
      .filter((i) => i.code !== 'unrecognized_keys' && !bodyWideRefinement(i))
      .map((i) => ({ code: 'BAD_REQUEST', path: jsonPointer(i.path), detail: i.message })),
  ];
  throw new RefusalError(rows, 'ISSUE_UPDATE_REFUSED');
}
