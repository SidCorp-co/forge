// Delete a comment on a requirement (`DELETE …/requirements/:req/comments/:comment`), by its author or
// a holder of `project.write` (REQ-48 BC-12: the steward's intake question and brief are undone here).
// A decision is a record and is kept; a comment somebody replied to is kept, so no reply is left
// answering nothing. Refused by name either way, and nothing is written.

import type { CommentRefusal, EntityCommentScope } from '@forge/contracts/comments';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { notFound } from '../middleware/route-errors.js';
import { actorFor, permissionRefusal, projectResource, requireCan } from '../permissions/index.js';
import { commentRowIn, type EntityCommentActor, targetIn } from './entity-read.js';
import { sitsOn } from './entity-rules.js';

export type EntityCommentDelete = { ok: true } | { ok: false; refusals: CommentRefusal[] };

export async function deleteEntityComment(input: {
  projectId: string;
  scope: EntityCommentScope;
  ref: string;
  commentId: string;
  actor: EntityCommentActor;
}): Promise<EntityCommentDelete> {
  const { projectId, scope, commentId, actor } = input;
  const facts = await requireCan(
    actorFor(actor.userId),
    'project.read',
    projectResource(projectId),
  );
  return db.transaction(async (tx) => {
    const target = await targetIn(tx, projectId, scope, input.ref);
    await lockXact(tx, 'commentTarget', target.id);
    const row = await commentRowIn(tx, commentId);
    if (!row || !sitsOn(row, scope, target.id)) {
      throw notFound(`${target.key} holds no comment ${commentId}`);
    }
    const forbidden =
      row.authorId === actor.userId
        ? null
        : permissionRefusal(facts, 'project.write', `deleting another's comment on ${target.key}`);
    if (forbidden) return { ok: false, refusals: [forbidden as CommentRefusal] };
    if (row.intent === 'decision') {
      return {
        ok: false,
        refusals: [
          {
            code: 'COMMENT_RECORD_KEPT',
            path: '/comment',
            detail: `comment ${commentId} is a decision on ${target.key}, which is a record and is kept; post a new decision that supersedes it`,
          },
        ],
      };
    }
    const [reply] = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.parentId, row.id))
      .limit(1);
    if (reply) {
      return {
        ok: false,
        refusals: [
          {
            code: 'COMMENT_HAS_REPLIES',
            path: '/comment',
            detail: `comment ${commentId} on ${target.key} has a reply (${reply.id}), which would be left answering nothing; it is kept`,
          },
        ],
      };
    }
    await tx.delete(comments).where(eq(comments.id, row.id));
    return { ok: true };
  });
}
