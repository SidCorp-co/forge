// Posting a comment on an issue, by every door that takes one: REST's `POST /api/issues/:id/comments`
// and the MCP door's `forge_questions ask` (a comment marked as a question, owed a reply).

import type { CommentRefusalCode, DecisionFields } from '@forge/contracts/comments';
import { HTTPException } from 'hono/http-exception';
import type { Actor } from '../issues/index.js';
import { loadProjectAccess } from '../lib/authz.js';
import { pgConstraintName, pgErrorCode } from '../lib/db-errors.js';
import { refuser } from '../lib/refusal.js';
import { notFound } from '../middleware/route-errors.js';
import { requireHeld } from '../permissions/index.js';
import { bodyRefusalHttp } from './body-input.js';
import { issueProjectOf, parentCommentOf } from './read.js';
import { decisionBody, insertComment, type NewComment } from './service.js';

const refuse = refuser<CommentRefusalCode>('COMMENT_REFUSED');

export async function loadIssue(issueId: string) {
  const row = await issueProjectOf(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

async function assertParentOnIssue(parentId: string, issueId: string): Promise<void> {
  const parent = await parentCommentOf(parentId);
  if (!parent) throw notFound('parent comment not found');
  if (parent.issueId !== issueId) {
    throw new HTTPException(400, {
      message: 'parent comment belongs to a different issue',
      cause: { code: 'PARENT_MISMATCH' },
    });
  }
}

/** A failed comment insert as the answer it owes: a body refusal, a reply nested too deep, a parent
 *  gone under it, or the error itself (a message refusal is answered by the shared error handler). */
function commentWriteRefusal(err: unknown, parentId: string | undefined): unknown {
  const refusal = bodyRefusalHttp(err);
  if (refusal) return refusal;
  const pgCode = pgErrorCode(err);
  if (pgCode === '23514') {
    return refuse(
      'COMMENT_DEPTH_EXCEEDED',
      'a reply sits at most 3 deep; reply to a comment higher in the thread',
      '/parentId',
    );
  }
  if (pgCode === '23503' && parentId && pgConstraintName(err) === 'comments_parent_id_fk') {
    return notFound('parent comment not found');
  }
  return err;
}

/**
 * The body an issue comment is stored with: the one sent, or for a decision sent as fields only,
 * the fields written out, so every reader of the body (the thread, MCP, the CLI) reads the ruling.
 */
function issueCommentBody(
  sent: string | undefined,
  intent: string | undefined,
  decision: DecisionFields | undefined,
): string {
  if (decision && intent !== 'decision') {
    throw refuse(
      'COMMENT_DECISION_INTENT_MISMATCH',
      `decision fields belong to intent decision; this comment is ${intent ? `a ${intent}` : 'sent with no intent'}. Send intent: decision, or drop the decision fields`,
      '/decision',
    );
  }
  if (sent !== undefined) return sent;
  if (!decision) {
    throw refuse(
      'COMMENT_BODY_REQUIRED',
      'a comment carries a body: the sentence somebody is meant to read (a decision may send decision: { decision, reason } instead)',
      '/body',
    );
  }
  return decisionBody(decision);
}

/** One comment posted on `issueId` by `authorId`, who must be able to write its project. */
export async function postIssueComment(input: {
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string | undefined;
  format?: NewComment['format'];
  parentId?: string | undefined;
  intent?: string | undefined;
  decision?: DecisionFields | undefined;
  writtenLang?: NewComment['writtenLang'];
  declaresRecordRoute: boolean;
  announce: { actor: Actor; authored: 'human' | 'agent' };
}) {
  const { issueId, parentId } = input;
  const body = issueCommentBody(input.body, input.intent, input.decision);
  const issue = await loadIssue(issueId);
  const access = await loadProjectAccess(issue.projectId, input.authorId);
  requireHeld(access, 'project.write');
  if (parentId) await assertParentOnIssue(parentId, issueId);
  return insertComment({
    issueId,
    authorId: input.authorId,
    authorDeviceId: input.authorDeviceId,
    body,
    format: input.format,
    parentId: parentId ?? null,
    declaresRecordRoute: input.declaresRecordRoute,
    intent: input.intent,
    decision: input.decision ?? null,
    writtenLang: input.writtenLang,
    announce: input.announce,
  }).catch((err: unknown) => {
    throw commentWriteRefusal(err, parentId);
  });
}
