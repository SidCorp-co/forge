import { feedbackKey } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import type { Tx } from '../db/client.js';
import { feedback, feedbackCases } from '../db/schema-feedback.js';
import { findIssueById, isUuid } from '../issues/index.js';
import { rowIn as requirementRowIn } from '../requirements/index.js';

export interface FeedbackActor {
  userId: string;
  agency: ActorAgency;
}

export type Row = typeof feedback.$inferSelect;

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

/** An item of `projectId` by uuid, `FB-n` or `n`, locked for update when asked; 404 otherwise. */
export async function rowIn(tx: Tx, projectId: string, ref: string, lock = false): Promise<Row> {
  const seq = /^(?:FB-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = isUuid(ref) ? ref : null;
  if (!seq && !uuid) throw notFound(`"${ref}" is neither a feedback uuid nor a key like FB-12`);
  const query = tx
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, projectId),
        seq ? eq(feedback.fbSeq, Number(seq)) : eq(feedback.id, uuid as string),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound(`project ${projectId} holds no feedback ${ref}`);
  return row;
}

export type CaseRow = typeof feedbackCases.$inferSelect;

export async function caseIn(tx: Tx, feedbackId: string): Promise<CaseRow | null> {
  const [row] = await tx
    .select()
    .from(feedbackCases)
    .where(eq(feedbackCases.feedbackId, feedbackId));
  return row ?? null;
}

/** The keys of the items marked duplicates of `feedbackId`, oldest first. */
export async function duplicateKeysOf(tx: Tx, feedbackId: string): Promise<string[]> {
  const rows = await tx
    .select({ seq: feedback.fbSeq })
    .from(feedback)
    .where(eq(feedback.duplicateOf, feedbackId))
    .orderBy(asc(feedback.fbSeq));
  return rows.map((r) => feedbackKey(r.seq));
}

export interface TargetRequirement {
  id: string;
  key: string;
  status: string;
}

/** The requirement an item is about: its target, or the requirement its target issue delivers. */
export async function targetRequirementOf(tx: Tx, row: Row): Promise<TargetRequirement | null> {
  const id =
    row.requirementId ??
    (row.issueId ? ((await findIssueById(row.issueId))?.requirementId ?? null) : null);
  if (!id) return null;
  const req = await requirementRowIn(tx, row.projectId, id);
  return { id: req.id, key: requirementKey(req.reqSeq), status: req.status };
}
