// What a mark or an unmark tells the rest of Forge once the row is written: the audit comment, and
// the three events its readers listen for, in the order they always went.

import { insertSystemComment } from '../comments/system-write.js';
import type { Actor } from '../pipeline/activity.js';
import { hooks } from '../pipeline/hooks.js';
import { findIssueById, type IssueRow } from './read-service.js';

export type AuditComment = { id: string; body: string; parentId: string | null };

export async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
): Promise<AuditComment | null> {
  const row = await insertSystemComment({ issueId, authorId, body, parentId: null });
  return row ? { id: row.id, body: row.body, parentId: row.parentId } : null;
}

/** The comment and the events; the issue as it now reads, or null where it is gone. */
export async function announceMark(
  before: { id: string; projectId: string; mergedAt: Date | null },
  args: { op: 'mark' | 'unmark'; actor: { commentAuthorId: string; hookActor: Actor } },
  body: string,
): Promise<IssueRow | null> {
  const auditComment = await writeAuditComment(before.id, args.actor.commentAuthorId, body);
  if (auditComment) {
    await hooks.emit('commentCreated', {
      issueId: before.id,
      projectId: before.projectId,
      actor: args.actor.hookActor,
      authored: 'agent',
      commentId: auditComment.id,
      body: auditComment.body,
      parentId: auditComment.parentId,
    });
  }
  const issue = await findIssueById(before.id);
  if (!issue) return null;
  await hooks.emit('issueUpdated', {
    issueId: before.id,
    projectId: before.projectId,
    actor: args.actor.hookActor,
    fields: ['mergedAt', 'mergedCommitSha', 'mergedLanding'],
    before: { mergedAt: before.mergedAt },
    after: {
      mergedAt: issue.mergedAt,
      mergedCommitSha: issue.mergedCommitSha,
      mergedLanding: issue.mergedLanding,
    },
  });
  await hooks.emit('contractInputChanged', {
    projectId: before.projectId,
    issueId: before.id,
    reason: args.op === 'mark' ? 'merged mark written' : 'merged mark cleared',
  });
  return issue;
}
