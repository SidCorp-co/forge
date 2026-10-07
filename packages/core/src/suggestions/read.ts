/**
 * The helpers every suggestion read and write resolves a target, a row, a view and a head with; the
 * list a requirement page or the BA door opens is `list.ts`.
 */

import type { ActorAgency } from '@forge/contracts/permissions';
import type { SuggestionView } from '@forge/contracts/suggestions';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import type { KernelActor } from '../lifecycle/index.js';
import { notFound } from '../middleware/route-errors.js';
import { rowIn } from '../requirements/index.js';
import type { SuggestionTarget } from './target.js';

export interface SuggestionActor {
  userId: string;
  agency: ActorAgency;
  /** The paired box whose credential made the call, or null for an account's own: the issues an
   *  accepted breakdown files carry it as a REST create does (`createdByDeviceId`). */
  deviceId?: string | null;
}

export function suggestionKernelActor(actor: SuggestionActor): KernelActor {
  return { type: 'user', id: actor.userId, agency: actor.agency };
}

export type Row = typeof suggestions.$inferSelect;

export const targetOfRow = (r: Row): SuggestionTarget =>
  r.requirementId
    ? { type: 'requirement', id: r.requirementId }
    : r.feedbackId
      ? { type: 'feedback', id: r.feedbackId }
      : r.workflowId
        ? { type: 'workflow', id: r.workflowId }
        : { type: 'issue', id: r.issueId as string };

export const viewOf = (r: Row): SuggestionView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  target: targetOfRow(r),
  baseRevision: r.baseRevision,
  payload: r.payload,
  payloadVersion: r.payloadVersion,
  fingerprint: r.fingerprint,
  revises: r.revisesId,
  producerKind: r.producerKind,
  producerId: r.producerId,
  conversationMessageId: r.conversationMessageId,
  model: r.model,
  decidedBy: r.decidedBy,
  decidedAt: r.decidedAt?.toISOString() ?? null,
  reason: r.reason,
  createdAt: r.createdAt.toISOString(),
  payloadPurgedAt: r.payloadPurgedAt?.toISOString() ?? null,
});

export const onTarget = (t: SuggestionTarget) =>
  t.type === 'requirement'
    ? eq(suggestions.requirementId, t.id)
    : t.type === 'feedback'
      ? eq(suggestions.feedbackId, t.id)
      : t.type === 'workflow'
        ? eq(suggestions.workflowId, t.id)
        : eq(suggestions.issueId, t.id);

/** The target's head revision: a requirement's current revision, none for an issue or feedback. */
export async function headOf(tx: Tx, projectId: string, t: SuggestionTarget) {
  return t.type === 'requirement' ? (await rowIn(tx, projectId, t.id)).currentRevision : null;
}

/** A suggestion of `projectId`, locked for update when asked; 404 otherwise. */
export async function rowOf(tx: Tx, projectId: string, id: string, lock = false): Promise<Row> {
  const query = tx
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.id, id), eq(suggestions.projectId, projectId)));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound(`project ${projectId} holds no suggestion ${id}`);
  return row;
}

export { resolveTarget, type SuggestionTarget, type SuggestionTargetRef } from './target.js';
