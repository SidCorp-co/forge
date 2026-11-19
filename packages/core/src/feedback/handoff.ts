/**
 * A finding handed to another project's intake (ISS-1286, REQ-102 BC-1): filed in the receiving
 * project as its feedback, and recorded on the item of the sending project it came from, in one
 * transaction, so neither side holds the handoff without the other. The receiving item's origin names
 * the sending project, its issue where the finding came from one, and who handed it, as a report
 * through the Forge door does (`forge-reads.ts:forgeOriginsOf`); an internal note on it names the
 * item it came from by key. The item it came from takes a note naming the receiving key: a comment
 * on an issue, an internal note on a feedback item. Who may hand it, and to which project, is the
 * ecosystem channel's to decide (`ecosystem/channel-handoff.ts`); this files what it decided.
 *
 * Handing the same item to the same project again, while what it filed there is open, joins that
 * item by its signal key. The same finding again is a retry and writes nothing, so a retried call
 * never files a twin; a different finding joins it as a further report, an occurrence carrying its
 * title, severity, where it was seen and its body, as a repeat of a signal does (`signal-filing.ts`),
 * and the sending item records where it went, so a second finding is never dropped in silence.
 */

import { createHash } from 'node:crypto';
import { type FeedbackKind, type FeedbackSeverity, feedbackKey } from '@forge/contracts/feedback';
import { and, eq } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import type { Tx } from '../db/client.js';
import { feedback, feedbackMessages, feedbackOccurrences } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { embedFeedbackLater } from './embeddings.js';
import { addOccurrenceIn } from './occurrences.js';
import type { FeedbackActor, Row } from './read.js';
import { insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';
import { openItemOf } from './signal-filing.js';

/** The item of the sending project a finding is handed from. */
export interface HandedItem {
  kind: 'issue' | 'feedback';
  id: string;
  key: string;
}

export interface Handoff {
  from: { id: string; slug: string; item: HandedItem };
  to: { id: string; slug: string };
  /** The ecosystem whose channel joins the two, by slug, as both notes name it. */
  via: string;
  actor: FeedbackActor;
  request: {
    kind: FeedbackKind;
    title: string;
    whereSeen: string;
    body?: string | undefined;
    severity?: FeedbackSeverity | undefined;
  };
}

export type HandoffFiling =
  | { ok: true; id: string; key: string; created: boolean }
  | { ok: false; refusals: Refusal[] };

const handedTo = (h: Handoff, key: string) =>
  `Handed to ${h.to.slug}'s intake as ${h.to.slug} ${key}, through ecosystem ${h.via}.`;

const handedFurther = (h: Handoff, key: string) =>
  `Handed a further finding to ${h.to.slug}'s intake, joining ${h.to.slug} ${key}, through ecosystem ${h.via}.`;

const handedFrom = (h: Handoff) =>
  `Handed from ${h.from.slug} ${h.from.item.key}, through ecosystem ${h.via}.`;

/** The signal key one item handed to one project is filed under, whatever its title says. */
export const handoffSignalKey = (fromProjectId: string, itemId: string) =>
  `handoff:${fromProjectId}:${itemId}`;

/** An internal note in Forge's own English, written as the one who handed the finding. */
async function noteOn(
  tx: Tx,
  h: Handoff,
  at: { projectId: string; feedbackId: string },
  body: string,
) {
  await tx.insert(feedbackMessages).values({
    ...at,
    audience: 'internal',
    body,
    recipients: [],
    sentBy: h.actor.userId,
    sentAgency: h.actor.agency,
    writtenLang: 'en',
  });
}

/** The record the sending item keeps of where its finding went. */
async function recordOnSource(tx: Tx, h: Handoff, said: string): Promise<void> {
  const { item } = h.from;
  if (item.kind === 'issue') {
    await postIssueNotice({ issueId: item.id, authorId: h.actor.userId, body: said }, tx);
    return;
  }
  await noteOn(tx, h, { projectId: h.from.id, feedbackId: item.id }, said);
}

/** Where a handed finding comes from, as its occurrence names it. */
const sourceOf = (h: Handoff) => ({
  projectId: h.from.id,
  issueId: h.from.item.kind === 'issue' ? h.from.item.id : null,
  runId: null,
  clientVersion: null,
});

/** What a finding says, as stored: the fields a retry repeats and a further finding changes. */
type Finding = Pick<Row, 'kind' | 'severity' | 'title' | 'body' | 'whereSeen'>;

const digestOf = (f: Finding): string =>
  createHash('sha256')
    .update(JSON.stringify([f.kind, f.severity, f.title, f.body ?? null, f.whereSeen ?? null]))
    .digest('hex')
    .slice(0, 32);

/** A further finding as its occurrence says it: title, severity and kind, where seen, then its body. */
const furtherSaid = (f: Finding): string =>
  [
    f.title,
    `Severity ${f.severity}, ${f.kind}${f.whereSeen ? `, seen at ${f.whereSeen}` : ''}.`,
    f.body ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');

/**
 * A finding handed again to the open item it filed: a retry of what it filed, or of a further
 * finding already joined, writes nothing; a different one joins it as an occurrence and the sending
 * item records it.
 */
async function joinOpen(tx: Tx, h: Handoff, open: Row, finding: Finding): Promise<void> {
  const digest = digestOf(finding);
  if (digest === digestOf(open)) return;
  const dedupKey = `handoff:${open.id}:${digest}`;
  const [joined] = await tx
    .select({ id: feedbackOccurrences.id })
    .from(feedbackOccurrences)
    .where(
      and(eq(feedbackOccurrences.feedbackId, open.id), eq(feedbackOccurrences.dedupKey, dedupKey)),
    )
    .limit(1);
  if (joined) return;
  await addOccurrenceIn(tx, open.id, h.actor, sourceOf(h), {
    said: furtherSaid(finding),
    dedupKey,
  });
  await recordOnSource(tx, h, handedFurther(h, feedbackKey(open.fbSeq)));
}

async function seqOf(tx: Tx, id: string): Promise<number> {
  const [row] = await tx.select({ seq: feedback.fbSeq }).from(feedback).where(eq(feedback.id, id));
  if (!row) throw new Error('feedback: a handed item reads back no row');
  return row.seq;
}

/** Files the finding in the receiving project and records it on both items, or joins what it already filed. */
export async function fileHandoff(h: Handoff): Promise<HandoffFiling> {
  const { request } = h;
  const prepared = await preparedFeedback(h.to.id, h.actor, {
    kind: request.kind,
    title: request.title,
    screen: request.whereSeen,
    ...(request.severity ? { severity: request.severity } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
  });
  if (!prepared.ok) return prepared;
  const signalKey = handoffSignalKey(h.from.id, h.from.item.id);
  let id = '';
  let seq = 0;
  let created = false;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, h.to.id);
    const open = await openItemOf(tx, h.to.id, signalKey);
    if (open) {
      id = open.id;
      seq = open.fbSeq;
      await joinOpen(tx, h, open, {
        kind: prepared.values.kind,
        severity: prepared.values.severity ?? 'medium',
        title: prepared.values.title,
        body: prepared.values.body ?? null,
        whereSeen: prepared.values.whereSeen ?? null,
      });
      return null;
    }
    id = await insertFeedbackIn(tx, { ...prepared.values, signalKey });
    seq = await seqOf(tx, id);
    await addOccurrenceIn(tx, id, h.actor, sourceOf(h));
    await noteOn(tx, h, { projectId: h.to.id, feedbackId: id }, handedFrom(h));
    await recordOnSource(tx, h, handedTo(h, feedbackKey(seq)));
    created = true;
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return { ok: true, id, key: feedbackKey(seq), created };
}
