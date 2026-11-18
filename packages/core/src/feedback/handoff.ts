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
 * item by its signal key and writes nothing, so a retried call never files a twin.
 */

import { type FeedbackKind, type FeedbackSeverity, feedbackKey } from '@forge/contracts/feedback';
import { eq } from 'drizzle-orm';
import { postIssueNotice } from '../comments/index.js';
import type { Tx } from '../db/client.js';
import { feedback, feedbackMessages } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { embedFeedbackLater } from './embeddings.js';
import { addOccurrenceIn } from './occurrences.js';
import type { FeedbackActor } from './read.js';
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
async function recordOnSource(tx: Tx, h: Handoff, key: string): Promise<void> {
  const said = handedTo(h, key);
  const { item } = h.from;
  if (item.kind === 'issue') {
    await postIssueNotice({ issueId: item.id, authorId: h.actor.userId, body: said }, tx);
    return;
  }
  await noteOn(tx, h, { projectId: h.from.id, feedbackId: item.id }, said);
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
      return null;
    }
    id = await insertFeedbackIn(tx, { ...prepared.values, signalKey });
    seq = await seqOf(tx, id);
    await addOccurrenceIn(tx, id, h.actor, {
      projectId: h.from.id,
      issueId: h.from.item.kind === 'issue' ? h.from.item.id : null,
      runId: null,
      clientVersion: null,
    });
    await noteOn(tx, h, { projectId: h.to.id, feedbackId: id }, handedFrom(h));
    await recordOnSource(tx, h, feedbackKey(seq));
    created = true;
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return { ok: true, id, key: feedbackKey(seq), created };
}
