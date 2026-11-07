/**
 * A filing joined by its signal key (REQ-47 BC-5, REQ-87 BC-2): an open item of the project that
 * names the key takes the report as an occurrence; with none, a new item is filed at phase new. One
 * path for the Forge door (`forge-intake.ts`, into Forge's home project) and a script schedule's
 * ctx.feedback.file (its own project), so a key means the same thing to both.
 */

import type { CreateFeedbackRequest } from '@forge/contracts/feedback';
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { embedFeedbackLater } from './embeddings.js';
import { linkedOf, phaseIn } from './list-read.js';
import { addOccurrenceIn, type OccurrenceSource } from './occurrences.js';
import type { FeedbackActor, Row } from './read.js';
import { insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

/** The phases an item is closed at: a report of its signal key after them files a new item. */
const CLOSED: readonly string[] = ['verified', 'declined'];

/** The open item `signalKey` names in the project, a duplicate read as its root; null where none is. */
export async function openItemOf(tx: Tx, projectId: string, signalKey: string): Promise<Row | null> {
  const named = await tx
    .select()
    .from(feedback)
    .where(and(eq(feedback.projectId, projectId), eq(feedback.signalKey, signalKey)))
    .orderBy(desc(feedback.createdAt));
  for (const row of named) {
    let item = row;
    if (row.duplicateOf) {
      const [root] = await tx.select().from(feedback).where(eq(feedback.id, row.duplicateOf));
      if (!root) continue;
      item = root;
    }
    if (item.redactedAt) continue;
    const phase = phaseIn(item, await linkedOf(projectId, [item]));
    if (!CLOSED.includes(phase)) return item;
  }
  return null;
}

type Prepared = Extract<Awaited<ReturnType<typeof preparedFeedback>>, { ok: true }>['values'];

export type SignalFiling =
  | { ok: true; id: string; key: string; created: boolean }
  | { ok: false; refusals: Refusal[] };

/**
 * Files one prepared report as `actor` under the project's feedback lock: an occurrence of the open
 * item with `signalKey` where there is one, else a new item carrying the key.
 */
export async function fileBySignal(input: {
  values: Prepared;
  actor: FeedbackActor;
  signalKey: string;
  source: OccurrenceSource;
}): Promise<SignalFiling> {
  const { projectId } = input.values;
  let id = '';
  let seq = 0;
  let created = false;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const open = await openItemOf(tx, projectId, input.signalKey);
    if (open) {
      id = open.id;
      seq = open.fbSeq;
    } else {
      id = await insertFeedbackIn(tx, { ...input.values, signalKey: input.signalKey });
      const [row] = await tx
        .select({ seq: feedback.fbSeq })
        .from(feedback)
        .where(eq(feedback.id, id));
      seq = row?.seq ?? 0;
      created = true;
    }
    await addOccurrenceIn(tx, id, input.actor, input.source);
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return { ok: true, id, key: `FB-${seq}`, created };
}

/**
 * One report filed into `projectId` as `actor`, joined by `signalKey` (REQ-87 BC-2): prepared as the
 * project door prepares one (its data policy scrubs title and body), then filed or joined. A script
 * schedule's filing comes here with the project's own agent as `actor` and the schedule as the
 * screen it was seen on, so it reads as the schedule's and never a person's.
 */
export async function fileSignalFeedback(input: {
  projectId: string;
  actor: FeedbackActor;
  request: Pick<CreateFeedbackRequest, 'kind' | 'title' | 'body' | 'severity' | 'screen'>;
  signalKey: string;
  source: OccurrenceSource;
}): Promise<SignalFiling> {
  const prepared = await preparedFeedback(input.projectId, input.actor, {
    kind: input.request.kind,
    title: input.request.title,
    ...(input.request.screen ? { screen: input.request.screen } : {}),
    ...(input.request.severity ? { severity: input.request.severity } : {}),
    ...(input.request.body !== undefined ? { body: input.request.body } : {}),
  });
  if (!prepared.ok) return prepared;
  return fileBySignal({
    values: prepared.values,
    actor: input.actor,
    signalKey: input.signalKey,
    source: input.source,
  });
}
