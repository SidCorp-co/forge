/**
 * What a reporter adds beside the item (UC15's reporter data): attachments, flagged when the
 * project's data policy is on (Q8), and the one clarification the BA assistant may ask (Q5).
 */

import { randomUUID } from 'node:crypto';
import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedbackAttachments } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { allowedSetForTarget, resolveAttachmentMime, safeName } from '../lib/attachment-mime.js';
import { assertProjectAccess } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { logger } from '../logger.js';
import { askQuestion } from '../questions/write.js';
import { getStorage } from '../storage/index.js';
import { type FeedbackActor, feedbackKey, phaseOfRow, rowIn } from './read.js';
import { clarificationRefusal, redactedRefusal } from './rules.js';
import { answer, type FeedbackOutcome, inTx, lockFeedback } from './service.js';

/** The BA assistant asks the reporter one clarification (Q5); the answer becomes a suggestion, never an edit. */
export async function askClarification(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  prompt: string;
  needed: string;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'member');
  const row = await rowIn(db, projectId, input.ref);
  const [open] = await db
    .select({ id: agentQuestions.id })
    .from(agentQuestions)
    .where(and(eq(agentQuestions.feedbackId, row.id), eq(agentQuestions.status, 'open')));
  const refused = clarificationRefusal(await phaseOfRow(projectId, row), open?.id ?? null);
  if (refused) return { ok: false, refusals: [refused] };
  try {
    await askQuestion({
      id: randomUUID(),
      projectId,
      feedbackId: row.id,
      prompt: input.prompt,
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: input.needed },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = clarificationRefusal('new', 'one asked concurrently');
    return { ok: false, refusals: again ? [again] : [] };
  }
  return answer(projectId, row.id, actor);
}

/** A reporter's attachment, flagged when the project's data policy is on (Q8). */
export async function addAttachment(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  name: string;
  mime: string;
  contentBase64: string;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'member');
  const row = await rowIn(db, projectId, input.ref);
  const invalid = (detail: string): FeedbackOutcome => ({
    ok: false,
    refusals: [{ code: 'FEEDBACK_ATTACHMENT_INVALID', path: '/contentBase64', detail }],
  });
  const done = redactedRefusal(row.redactedAt);
  if (done) return { ok: false, refusals: [done] };
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length === 0)
    return invalid('the attachment decodes to no bytes; send its content as base64.');
  if (bytes.length > FEEDBACK_LIMITS.attachmentBytes) {
    return invalid(
      `the attachment is ${bytes.length} bytes; at most ${FEEDBACK_LIMITS.attachmentBytes} are stored.`,
    );
  }
  const mime = resolveAttachmentMime({
    target: 'issue',
    name: input.name,
    declaredMime: input.mime,
    bytes,
  });
  if (!mime.ok) {
    return {
      ok: false,
      refusals: [
        {
          code: 'FEEDBACK_ATTACHMENT_INVALID',
          path: '/mime',
          detail: `${mime.mime || 'this type'} is not stored here; allowed: ${allowedSetForTarget('issue').mimes.join(', ')}.`,
        },
      ],
    };
  }
  const level = await dataPolicyOf(projectId);
  const name = safeName(input.name);
  const key = `feedback/${projectId}/${row.id}/${randomUUID()}-${name}`;
  const stored = await getStorage().put(key, bytes, mime.mime);
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const held = await tx
      .select({ id: feedbackAttachments.id })
      .from(feedbackAttachments)
      .where(eq(feedbackAttachments.feedbackId, row.id));
    if (held.length >= FEEDBACK_LIMITS.attachmentsPerItem) {
      return [
        {
          code: 'FEEDBACK_ATTACHMENT_INVALID',
          path: '',
          detail: `${feedbackKey(row.fbSeq)} already holds ${held.length} attachments, the most one item keeps.`,
        },
      ];
    }
    await tx.insert(feedbackAttachments).values({
      projectId,
      feedbackId: row.id,
      name,
      mime: mime.mime,
      size: bytes.length,
      storagePath: stored.path,
      flagged: level !== 'off',
      uploadedBy: actor.userId,
    });
    return null;
  });
  if (refusals) {
    await getStorage()
      .delete(stored.path)
      .catch((err: unknown) =>
        logger.error({ err, path: stored.path }, 'feedback: a refused attachment was not removed'),
      );
    return { ok: false, refusals };
  }
  return answer(projectId, row.id, actor);
}

/** The bytes of one attachment, for a viewer of the project. */
export async function attachmentBytes(input: {
  projectId: string;
  ref: string;
  attachmentId: string;
  userId: string;
}) {
  await assertProjectAccess(input.projectId, input.userId, 'viewer');
  const row = await rowIn(db, input.projectId, input.ref);
  const [a] = await db
    .select()
    .from(feedbackAttachments)
    .where(
      and(
        eq(feedbackAttachments.id, input.attachmentId),
        eq(feedbackAttachments.feedbackId, row.id),
      ),
    );
  if (!a) return null;
  return { name: a.name, mime: a.mime, bytes: await getStorage().get(a.storagePath) };
}
