/**
 * Feedback about Forge itself (REQ-47): filed into the project the instance names as Forge's home,
 * from any project, as the reporter's own account (BC-1, BC-2). It is the same row the project door
 * writes, through the same preparation and insert under the home project's feedback lock; what differs
 * is that the reporter need not be a member of the home project (BC-3), and that each report records
 * where it came from (BC-4) and joins an open item with its signal key rather than filing a twin
 * (BC-5). Nothing is written where the instance names no home (BC-6).
 */

import type {
  ForgeFeedbackRefusalCode,
  ForgeFeedbackRequest,
} from '@forge/contracts/forge-feedback';
import { and, desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { forgeHomeProject } from '../instance-settings/index.js';
import type { Refusal } from '../lib/refusal.js';
import { embedFeedbackLater } from './embeddings.js';
import { linkedOf, phaseIn } from './list-read.js';
import { addOccurrenceIn, type OccurrenceSource } from './occurrences.js';
import type { FeedbackActor, Row } from './read.js';
import { insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

/** Where one report came from, already checked against what its reporter may read. */
export type ForgeSource = OccurrenceSource;

export const forgeRefusal = (
  code: ForgeFeedbackRefusalCode,
  path: string,
  detail: string,
): Refusal => ({ code, path, detail });

export const HOME_NOT_SET = forgeRefusal(
  'FORGE_HOME_NOT_SET',
  '',
  'this Forge instance names no project as its home, so feedback about Forge has nowhere to go and nothing was written. An instance admin names it: PATCH /api/admin/instance-settings { baseRevision, patch: { forgeHomeProjectId } }.',
);

/** The phases an item is closed at: a report of its signal key after them files a new item. */
const CLOSED: readonly string[] = ['verified', 'declined'];

/**
 * What a report is about: the key it names, or its kind and title folded to lower case, letters and
 * digits, so two reporters wording one title alike name one key.
 */
export function signalKeyOf(request: Pick<ForgeFeedbackRequest, 'signalKey' | 'kind' | 'title'>) {
  if (request.signalKey) return request.signalKey;
  const folded = request.title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return `${request.kind}:${folded || '-'}`;
}

/** The open item `signalKey` names in the home project, a duplicate read as its root; null where none is. */
export async function openItemOf(tx: Tx, homeId: string, signalKey: string): Promise<Row | null> {
  const named = await tx
    .select()
    .from(feedback)
    .where(and(eq(feedback.projectId, homeId), eq(feedback.signalKey, signalKey)))
    .orderBy(desc(feedback.createdAt));
  for (const row of named) {
    let item = row;
    if (row.duplicateOf) {
      const [root] = await tx.select().from(feedback).where(eq(feedback.id, row.duplicateOf));
      if (!root) continue;
      item = root;
    }
    if (item.redactedAt) continue;
    const phase = phaseIn(item, await linkedOf(homeId, [item]));
    if (!CLOSED.includes(phase)) return item;
  }
  return null;
}

export type ForgeFiling =
  | { ok: true; homeId: string; id: string; created: boolean }
  | { ok: false; refusals: Refusal[] };

/**
 * Files one report about Forge as `actor`, into the home project: an occurrence of the open item
 * with its signal key where there is one, else a new item at phase new. Refused by name, with nothing
 * written, where the instance names no home.
 */
export async function fileForgeFeedback(input: {
  actor: FeedbackActor;
  request: ForgeFeedbackRequest;
  source: ForgeSource;
}): Promise<ForgeFiling> {
  const home = await forgeHomeProject();
  if (!home) return { ok: false, refusals: [HOME_NOT_SET] };
  const { actor, request, source } = input;
  const prepared = await preparedFeedback(home.id, actor, {
    kind: request.kind,
    title: request.title,
    screen: request.whereSeen,
    ...(request.severity ? { severity: request.severity } : {}),
    ...(request.body !== undefined ? { body: request.body } : {}),
    ...(request.writtenLang ? { writtenLang: request.writtenLang } : {}),
  });
  if (!prepared.ok) return prepared;
  const signalKey = signalKeyOf(request);
  let id = '';
  let created = false;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, home.id);
    const open = await openItemOf(tx, home.id, signalKey);
    if (open) {
      id = open.id;
    } else {
      id = await insertFeedbackIn(tx, { ...prepared.values, signalKey });
      created = true;
    }
    await addOccurrenceIn(tx, id, actor, source);
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return { ok: true, homeId: home.id, id, created };
}
