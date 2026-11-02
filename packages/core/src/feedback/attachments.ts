/**
 * What a reporter adds beside the item (UC15's reporter data): attachments, flagged when the
 * project's data policy is on (Q8), and the one clarification the BA assistant may ask (Q5), with the
 * answer it recommends, one at a time to each reporter (REQ-66 BC-4).
 */

import { randomUUID } from 'node:crypto';
import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  FEEDBACK_LIMITS,
  type FeedbackAttachmentLabel,
  type FeedbackRefusalCode,
  type FeedbackView,
  feedbackKey,
} from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { and, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackAttachments } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { getStorage } from '../integrations/index.js';
import { allowedSetForTarget, resolveAttachmentMime, safeName } from '../lib/attachment-mime.js';
import { dataPolicyOf, egressBytesAs } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import type { Refusal } from '../lib/refusal.js';
import { actorFor, permissionRefusal, projectResource, requireCan } from '../permissions/index.js';
import { insertAskedQuestion } from '../questions/index.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, rowIn } from './read.js';
import { clarificationRefusal, redactedRefusal } from './rules.js';
import { answer, type FeedbackOutcome, inTx, lockFeedback, roleFacts } from './service.js';

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

/** An attachment as sent, checked: its bytes, the type they are stored as, and a safe name. */
export type CheckedAttachment = { bytes: Buffer; mime: string; name: string };

const attachmentRefusal = (
  code: Extract<
    FeedbackRefusalCode,
    'EMPTY_FILE' | 'FILE_TOO_LARGE' | 'MIME_NOT_ALLOWED' | 'FEEDBACK_ATTACHMENTS_FULL'
  >,
  path: string,
  detail: string,
): Refusal => ({ code, path, detail });

/**
 * The bytes sent as base64, refused by name where they are empty (EMPTY_FILE), too large
 * (FILE_TOO_LARGE) or of a type an issue attachment is not kept as (MIME_NOT_ALLOWED): the names and
 * the allow-list every attachment write uses.
 */
export function checkedAttachment(
  input: { name: string; mime: string; contentBase64: string },
  at = '',
): { ok: true; file: CheckedAttachment } | { ok: false; refusal: Refusal } {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length === 0) {
    return {
      ok: false,
      refusal: attachmentRefusal(
        'EMPTY_FILE',
        `${at}/contentBase64`,
        'the attachment decodes to no bytes; send its content as base64.',
      ),
    };
  }
  if (bytes.length > FEEDBACK_LIMITS.attachmentBytes) {
    return {
      ok: false,
      refusal: attachmentRefusal(
        'FILE_TOO_LARGE',
        `${at}/contentBase64`,
        `the attachment is ${bytes.length} bytes; at most ${FEEDBACK_LIMITS.attachmentBytes} are stored.`,
      ),
    };
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
      refusal: attachmentRefusal(
        'MIME_NOT_ALLOWED',
        `${at}/mime`,
        `${mime.mime || 'this type'} is not stored here; allowed: ${allowedSetForTarget('issue').mimes.join(', ')}.`,
      ),
    };
  }
  return { ok: true, file: { bytes, mime: mime.mime, name: safeName(input.name) } };
}

/** Puts the checked bytes in storage under the item, before the row that names them is written. */
export async function storedAttachment(
  projectId: string,
  itemId: string,
  file: CheckedAttachment,
): Promise<string> {
  const key = `feedback/${projectId}/${itemId}/${randomUUID()}-${file.name}`;
  return (await getStorage().put(key, file.bytes, file.mime)).path;
}

/** Removes stored bytes whose row was refused. */
export async function dropStored(path: string): Promise<void> {
  await getStorage()
    .delete(path)
    .catch((err: unknown) =>
      logger.error({ err, path }, 'feedback: a refused attachment was not removed'),
    );
}

/**
 * Writes the row naming stored bytes on the item, under its feedback lock: refused where the item
 * already holds the most attachments it keeps. Flagged on a sensitive project (Q8).
 */
export async function insertAttachmentIn(
  tx: Tx,
  row: { id: string; projectId: string; fbSeq: number },
  file: CheckedAttachment & {
    path: string;
    redacted: boolean;
    label?: FeedbackAttachmentLabel | undefined;
  },
  uploadedBy: string,
  level: SensitiveDataLevel,
): Promise<{ ok: true; id: string } | { ok: false; refusal: Refusal }> {
  const held = await tx
    .select({ id: feedbackAttachments.id })
    .from(feedbackAttachments)
    .where(eq(feedbackAttachments.feedbackId, row.id));
  if (held.length >= FEEDBACK_LIMITS.attachmentsPerItem) {
    return {
      ok: false,
      refusal: attachmentRefusal(
        'FEEDBACK_ATTACHMENTS_FULL',
        '',
        `${feedbackKey(row.fbSeq)} already holds ${held.length} attachments, the most one item keeps.`,
      ),
    };
  }
  const [inserted] = await tx
    .insert(feedbackAttachments)
    .values({
      projectId: row.projectId,
      feedbackId: row.id,
      name: file.name,
      mime: file.mime,
      size: file.bytes.length,
      storagePath: file.path,
      flagged: level !== 'off',
      redacted: file.redacted,
      label: file.label ?? null,
      uploadedBy,
    })
    .returning({ id: feedbackAttachments.id });
  if (!inserted) throw new Error('feedback: the attachment insert returned no row');
  return { ok: true, id: inserted.id };
}

/** An attach: the item as it reads next and the new file's id, or the refusals that wrote nothing. */
export type AttachOutcome =
  | { ok: true; feedback: FeedbackView; attachmentId: string }
  | { ok: false; refusals: Refusal[] };

/**
 * A file attached to an existing item, flagged when the project's data policy is on (Q8): whoever may
 * comment on the item may attach (project.write, as a note and a comment take), and a label marks it
 * an approved design (ISS-879). The bytes go to the store every feedback attachment uses.
 */
export async function addAttachment(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  name: string;
  mime: string;
  contentBase64: string;
  redacted?: boolean | undefined;
  label?: FeedbackAttachmentLabel | undefined;
}): Promise<AttachOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const row = await rowIn(db, projectId, input.ref);
  const forbidden = permissionRefusal(
    await roleFacts(actor, projectId),
    'project.write',
    `attaching a file to ${feedbackKey(row.fbSeq)}`,
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const done = redactedRefusal(row.redactedAt);
  if (done) return { ok: false, refusals: [done] };
  const checked = checkedAttachment(input);
  if (!checked.ok) return { ok: false, refusals: [checked.refusal] };
  const level = await dataPolicyOf(projectId);
  const path = await storedAttachment(projectId, row.id, checked.file);
  const made: { id?: string } = {};
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const gone = redactedRefusal((await rowIn(tx, projectId, row.id, true)).redactedAt);
    if (gone) return [gone];
    const put = await insertAttachmentIn(
      tx,
      row,
      { ...checked.file, path, redacted: input.redacted === true, label: input.label },
      actor.userId,
      level,
    );
    if (!put.ok) return [put.refusal];
    made.id = put.id;
    return null;
  });
  if (refusals) {
    await dropStored(path);
    return { ok: false, refusals };
  }
  if (!made.id) throw new Error('feedback: an attach wrote no row and refused nothing');
  const read: FeedbackOutcome = await answer(projectId, row.id, actor);
  if (!read.ok) return read;
  return { ok: true, feedback: read.feedback, attachmentId: made.id };
}

/**
 * One attachment by its id alone, as a fetch reads it (ISS-879): its project, where its bytes are,
 * and the item route that serves them. Null when no feedback item holds that id.
 */
export async function feedbackAttachmentOf(attachmentId: string) {
  const [row] = await db
    .select({ a: feedbackAttachments, seq: feedback.fbSeq })
    .from(feedbackAttachments)
    .innerJoin(feedback, eq(feedback.id, feedbackAttachments.feedbackId))
    .where(eq(feedbackAttachments.id, attachmentId))
    .limit(1);
  if (!row) return null;
  const { a } = row;
  return {
    name: a.name,
    mime: a.mime,
    size: a.size,
    path: a.storagePath,
    projectId: a.projectId,
    url: `/api/projects/${a.projectId}/feedback/${feedbackKey(row.seq)}/attachments/${a.id}`,
    redacted: a.redacted,
  };
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
  // no scrubber reads a screenshot, so a model reads its bytes on a project that redacts only where
  // a person redacted it (REQ-66 BC-7), and never at no_egress
  const gate = await egressBytesAs(
    { agency: input.agency },
    input.projectId,
    'feedback.attachments',
    a.redacted,
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
