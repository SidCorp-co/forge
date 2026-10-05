// The refusals the issue create and patch doors share.

import type { IssueUpdateRefusalCode } from '@forge/contracts/issues';
import { BodyInvalidError } from '../body/errors.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import { refuser } from '../lib/refusal.js';
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
