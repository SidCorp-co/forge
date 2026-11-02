/**
 * A feedback item is a correction a lesson learns from (ISS-867, REQ-50 BC-1), kept in the
 * transaction of the act that settles it:
 * - triaged onto work, a bug or a change request says what the product or an agent got wrong, in its
 *   reporter's words (`feedback_triaged`); a question, an idea, a contract change and a duplicate
 *   (whose original already said it) correct nothing;
 * - declined with a reason, the triager says what the report itself got wrong
 *   (`feedback_declined`), which is how an agent that files a non-issue learns not to.
 * An item whose reporter's words were deleted is kept as no correction: there is nothing left to say.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { recordCorrection } from '../lessons/index.js';
import type { FeedbackActor, Row } from './read.js';

/** The kinds of item that say something was wrong, once triaged onto work. */
const CORRECTING_KINDS: ReadonlySet<Row['kind']> = new Set(['bug', 'change_request']);

const REASON_CHARS = 2000;

async function areaOf(tx: Tx, row: Row): Promise<string | null> {
  if (!row.requirementId) return null;
  const [req] = await tx
    .select({ area: requirements.areaId })
    .from(requirements)
    .where(eq(requirements.id, row.requirementId));
  return req?.area ?? null;
}

const itemOf = (row: Row) =>
  ({ kind: 'feedback', id: row.id, key: feedbackKey(row.fbSeq), title: row.title }) as const;

/** Keep a first triage onto work as its reporter's correction; answers whether one was kept. */
export async function keepTriageAsCorrection(tx: Tx, row: Row, route: string): Promise<boolean> {
  if (!CORRECTING_KINDS.has(row.kind) || route === 'duplicate' || row.redactedAt) return false;
  const said = row.body?.trim() ? `${row.title}: ${row.body.trim()}` : row.title;
  const kept = await recordCorrection(tx, {
    projectId: row.projectId,
    source: 'feedback_triaged',
    sourceRef: `${row.id}:triaged`,
    item: itemOf(row),
    areaId: await areaOf(tx, row),
    reason: said.slice(0, REASON_CHARS),
    by: { userId: row.reportedBy, agency: row.reporterAgency },
  });
  return kept !== null;
}

/** Keep a decline said with a reason as the triager's correction of the report. */
export async function keepDeclineAsCorrection(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  reason: string | null | undefined,
): Promise<boolean> {
  const kept = await recordCorrection(tx, {
    projectId: row.projectId,
    source: 'feedback_declined',
    sourceRef: `${row.id}:declined`,
    item: itemOf(row),
    areaId: await areaOf(tx, row),
    reason: reason?.slice(0, REASON_CHARS),
    by: { userId: actor.userId, agency: actor.agency === 'agent' ? 'agent' : 'human' },
  });
  return kept !== null;
}
