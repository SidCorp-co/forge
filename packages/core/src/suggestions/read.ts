/**
 * The reads of suggestions: the list a requirement page or the BA door opens, and the helpers every
 * write resolves a target, a row and a head with.
 */

import type { ActorAgency } from '@forge/contracts/permissions';
import type {
  SuggestionListResponse,
  SuggestionStatus,
  SuggestionView,
} from '@forge/contracts/suggestions';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { suggestions } from '../db/schema-suggestions.js';
import type { KernelActor } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { rowIn } from '../requirements/index.js';
import {
  notFound,
  resolveTarget,
  type SuggestionTarget,
  type SuggestionTargetRef,
} from './target.js';

export interface SuggestionActor {
  userId: string;
  agency: ActorAgency;
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

export async function listSuggestions(input: {
  projectId: string;
  userId: string;
  target?: SuggestionTargetRef | undefined;
  statuses?: readonly SuggestionStatus[] | undefined;
  limit?: number | undefined;
}): Promise<SuggestionListResponse> {
  await requireCan(actorFor(input.userId), 'project.read', projectResource(input.projectId));
  const target = input.target
    ? await resolveTarget(input.projectId, input.target, input.userId)
    : null;
  const scoped = and(
    eq(suggestions.projectId, input.projectId),
    target ? onTarget(target) : undefined,
  );
  const rows = await db
    .select()
    .from(suggestions)
    .where(
      and(
        scoped,
        input.statuses?.length ? inArray(suggestions.status, [...input.statuses]) : undefined,
      ),
    )
    .orderBy(desc(suggestions.createdAt))
    .limit(input.limit ?? 100);
  const [open] = await db
    .select({ n: count() })
    .from(suggestions)
    .where(and(scoped, eq(suggestions.status, 'proposed')));
  return { suggestions: rows.map(viewOf), open: open?.n ?? 0 };
}

export { resolveTarget, type SuggestionTarget, type SuggestionTargetRef } from './target.js';
