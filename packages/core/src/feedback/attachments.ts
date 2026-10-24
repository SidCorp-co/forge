/**
 * What a reporter adds beside the item (UC15's reporter data): attachments, flagged when the
 * project's data policy is on (Q8), and the one clarification the BA assistant may ask (Q5), with the
 * answer it recommends, one at a time to each reporter (REQ-66 BC-4).
 */

import { randomUUID } from 'node:crypto';
import { FEEDBACK_LIMITS, feedbackKey } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackAttachments } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { getStorage } from '../integrations/index.js';
import { allowedSetForTarget, resolveAttachmentMime, safeName } from '../lib/attachment-mime.js';
import { dataPolicyOf, egressAs } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { insertAskedQuestion } from '../questions/index.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, rowIn } from './read.js';
import { clarificationRefusal, redactedRefusal } from './rules.js';
import { answer, type FeedbackOutcome, inTx, lockFeedback } from './service.js';

/** The clarification open to this reporter on any of their items in the project, by question and item. */
async function openForReporter(
  tx: Tx,
  projectId: string,
  reporter: string,
): Promise<{ question: string; item: string } | null> {
  const [open] = await tx
    .select({ id: agentQuestions.id, seq: feedback.fbSeq })
    .from(agentQuestions)
    .innerJoin(feedback, eq(feedback.id, agentQuestions.feedbackId))
    .where(
      and(
        eq(feedback.projectId, projectId),
        eq(feedback.reportedBy, reporter),
        eq(agentQuestions.status, 'open'),
      ),
    )
    .limit(1);
  return open ? { question: open.id, item: feedbackKey(open.seq) } : null;
}

/**
 * The BA assistant asks the reporter one clarification (Q5) with the answer it recommends, which the
 * reporter sends by one click or writes over (REQ-66 BC-4); the answer becomes a suggestion, never an
 * edit. One is open at a time per item and per reporter, judged under the project's feedback lock.
 */
export async function askClarification(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  prompt: string;
  needed: string;
  recommended: string;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
  const first = await rowIn(db, projectId, input.ref);
  const phase = await phaseOfRow(projectId, first);
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const [open] = await tx
      .select({ id: agentQuestions.id })
      .from(agentQuestions)
      .where(and(eq(agentQuestions.feedbackId, row.id), eq(agentQuestions.status, 'open')));
    const refused =
      redactedRefusal(row.redactedAt) ??
      clarificationRefusal(
        phase,
        open?.id ?? null,
        await openForReporter(tx, projectId, row.reportedBy),
      );
    if (refused) return [refused];
    await insertAskedQuestion(tx, {
      id: randomUUID(),
      projectId,
      feedbackId: row.id,
      prompt: input.prompt,
      blockerKind: 'human',
      answer: { shape: 'free_text', needed: input.needed, recommended: input.recommended },
    });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor);
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
  await requireCan(actorFor(actor.userId), 'project.write', projectResource(projectId));
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
    const gone = redactedRefusal((await rowIn(tx, projectId, row.id, true)).redactedAt);
    if (gone) return [gone];
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
  agency: ActorAgency;
}) {
  await requireCan(actorFor(input.userId), 'project.read', projectResource(input.projectId));
  const row = await rowIn(db, input.projectId, input.ref);
  // the item's own, or evidence of a duplicate merged into it, which the item shows
  const merged = db
    .select({ id: feedback.id })
    .from(feedback)
    .where(eq(feedback.duplicateOf, row.id));
  const [a] = await db
    .select()
    .from(feedbackAttachments)
    .where(
      and(
        eq(feedbackAttachments.id, input.attachmentId),
        inArray(feedbackAttachments.feedbackId, [row.id, ...(await merged).map((m) => m.id)]),
      ),
    );
  if (!a) return null;
  const gate = await egressAs(
    { agency: input.agency },
    input.projectId,
    'feedback.attachments',
    null,
    `attachment ${a.id} of ${feedbackKey(row.fbSeq)}`,
  );
  if (!gate.ok) return { ok: false as const, refusal: gate.refusal };
  return {
    ok: true as const,
    name: a.name,
    mime: a.mime,
    bytes: await getStorage().get(a.storagePath),
  };
}
