/**
 * Feedback writes (workflows `feedback-lifecycle` rev 2 and `feedback-triage` rev 2). Each runs in
 * one transaction under the project's feedback lock and answers an outcome, refusals named and
 * nothing written. A person verifies or reopens; triage, decline and the case are `triage.ts`, attachments and
 * the clarification `attachments.ts`. Every decision is a `feedback_decisions` row.
 */

import type {
  CreateFeedbackRequest,
  FeedbackRoute,
  FeedbackTriageEffect,
  FeedbackView,
} from '@forge/contracts/feedback';
import type { NodeRef } from '@forge/contracts/workflow-health';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackAttachments, feedbackDecisions } from '../db/schema-feedback.js';
import { itemEmbeddings } from '../db/schema-item-embeddings.js';
import { mockups } from '../db/schema-mockups.js';
import { agentQuestions } from '../db/schema-questions.js';
import { suggestions } from '../db/schema-suggestions.js';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { logger } from '../logger.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { getStorage } from '../storage/index.js';
import { designNodesIn, nodeRefRefusal } from '../workflows/node-refs.js';
import { embedFeedbackLater } from './embeddings.js';
import { detailAs, type FeedbackActor, feedbackKey, phaseOfRow, type Row, rowIn } from './read.js';
import { isRefusal, resolveTarget } from './refs.js';
import {
  declineRefusal,
  redactActRefusal,
  redactedRefusal,
  reopenRefusal,
  targetCountRefusal,
  verifyActRefusal,
  verifyRefusal,
} from './rules.js';

export type FeedbackOutcome =
  | { ok: true; feedback: FeedbackView; created?: boolean; effect?: FeedbackTriageEffect }
  | { ok: false; refusals: NamedRefusal[] };

/** The transport a write came through, recorded on an issue a triage files. */
export type FeedbackChannel = 'web' | 'mcp';

export class Refused extends Error {
  constructor(readonly refusals: NamedRefusal[]) {
    super(refusals.map((r) => r.code).join(', '));
  }
}

export async function inTx(
  body: (tx: Tx) => Promise<NamedRefusal[] | null | undefined>,
): Promise<NamedRefusal[] | null> {
  try {
    return await db.transaction(async (tx) => {
      const refusals = await body(tx);
      if (refusals?.length) throw new Refused(refusals);
      return null;
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusals;
    throw err;
  }
}

/** Serialises every feedback write of a project, which also orders the FB-n it allocates. */
export async function lockFeedback(tx: Tx, projectId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`feedback:${projectId}`}, 0))`,
  );
}

export async function answer(
  projectId: string,
  id: string,
  viewer: FeedbackActor,
  extra: { created?: boolean; effect?: FeedbackTriageEffect } = {},
): Promise<FeedbackOutcome> {
  return { ok: true, feedback: await detailAs(viewer, projectId, id), ...extra };
}

export async function roleFacts(actor: FeedbackActor, projectId: string) {
  const access = await effectiveProjectRole(actor.userId, projectId);
  return { userId: actor.userId, agency: actor.agency, role: access?.role ?? null };
}

export async function decide(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  d: {
    decision: typeof feedbackDecisions.$inferInsert.decision;
    route?: FeedbackRoute | null;
    carrier?: string | null;
    reason?: string | null;
    fromSuggestionId?: string | null;
  },
) {
  const said = d.reason?.trim();
  // A reason is free text a person typed about the item; a sensitive project scrubs it like the body.
  const reason = said ? storedText(await dataPolicyOf(row.projectId), said).text : null;
  await tx.insert(feedbackDecisions).values({
    projectId: row.projectId,
    feedbackId: row.id,
    decision: d.decision,
    route: d.route ?? null,
    carrier: d.carrier ?? null,
    reason,
    decidedBy: actor.userId,
    decidedAgency: actor.agency,
    fromSuggestionId: d.fromSuggestionId ?? null,
  });
}

// cm:why a route picked closes the assistant's open clarification (feedback-lifecycle new -> triaged)
export async function closeClarification(tx: Tx, feedbackId: string, why: string) {
  await tx
    .update(agentQuestions)
    .set({
      status: 'void',
      voidReason: why,
      endedBy: 'feedback',
      endedReason: why,
      updatedAt: new Date(),
    })
    .where(and(eq(agentQuestions.feedbackId, feedbackId), eq(agentQuestions.status, 'open')));
}

export type NewFeedback = Omit<typeof feedback.$inferInsert, 'fbSeq'>;

export async function insertFeedbackIn(tx: Tx, values: NewFeedback): Promise<string> {
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${feedback.fbSeq}), 0)::int + 1` })
    .from(feedback)
    .where(eq(feedback.projectId, values.projectId));
  const [row] = await tx
    .insert(feedback)
    .values({ ...values, fbSeq: next })
    .returning({ id: feedback.id });
  if (!row) throw new Error('feedback: the insert returned no row');
  return row.id;
}

async function nodeColumns(
  projectId: string,
  workflowId: string | null,
  node: NodeRef | undefined,
): Promise<{ columns: Partial<NewFeedback> } | { refusal: NamedRefusal }> {
  if (!node) return { columns: {} };
  if (!workflowId) {
    return {
      refusal: {
        code: 'FEEDBACK_NODE_NEEDS_WORKFLOW',
        path: '/node',
        detail:
          'a node names a step or edge of a workflow; send it with a workflow target, or drop it',
      },
    };
  }
  const nodes = await designNodesIn(db, projectId, workflowId);
  const wrong = nodes ? nodeRefRefusal(nodes, node, '/node') : null;
  if (wrong) return { refusal: wrong };
  return {
    columns:
      'step' in node
        ? { stepId: node.step }
        : { edgeFrom: node.edge.from, edgeTo: node.edge.to, edgeLabel: node.edge.label ?? null },
  };
}

export async function preparedFeedback(
  projectId: string,
  actor: FeedbackActor,
  request: CreateFeedbackRequest,
): Promise<{ ok: true; values: NewFeedback } | { ok: false; refusals: NamedRefusal[] }> {
  const count = targetCountRefusal(request, request.whereSeen);
  if (count) return { ok: false, refusals: [count] };
  const target = await resolveTarget(projectId, request, actor.userId);
  if (isRefusal(target)) return { ok: false, refusals: [target] };
  const node = await nodeColumns(projectId, target.workflowId, request.node);
  if ('refusal' in node) return { ok: false, refusals: [node.refusal] };
  const level = await dataPolicyOf(projectId);
  const title = storedText(level, request.title.trim());
  const body = request.body?.trim() ? storedText(level, request.body) : null;
  const seen = target.screen ?? (request.whereSeen?.trim() || null);
  const whereSeen = seen ? storedText(level, seen) : null;
  return {
    ok: true,
    values: {
      projectId,
      kind: request.kind,
      severity: request.severity ?? 'medium',
      title: title.text,
      body: body?.text ?? null,
      whereSeen: whereSeen?.text ?? null,
      requirementId: target.requirementId,
      issueId: target.issueId,
      releaseRunId: target.releaseRunId,
      workflowId: target.workflowId,
      ...node.columns,
      reportedBy: actor.userId,
      reporterAgency: actor.agency,
      scrubbed: title.scrubbed,
      redactions: title.redactions + (body?.redactions ?? 0) + (whereSeen?.redactions ?? 0),
    },
  };
}

export async function createFeedback(input: {
  projectId: string;
  actor: FeedbackActor;
  request: CreateFeedbackRequest;
  /** E3's seam (ISS-61): a filer naming a key gets the one item already filed under it. */
  dedupKey?: string | undefined;
}): Promise<FeedbackOutcome> {
  const { projectId, actor, request } = input;
  await assertProjectAccess(projectId, actor.userId, 'member');
  const prepared = await preparedFeedback(projectId, actor, request);
  if (!prepared.ok) return prepared;
  let id = '';
  let created = true;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    if (input.dedupKey) {
      const [twin] = await tx
        .select({ id: feedback.id })
        .from(feedback)
        .where(and(eq(feedback.projectId, projectId), eq(feedback.dedupKey, input.dedupKey)));
      if (twin) {
        id = twin.id;
        created = false;
        return null;
      }
    }
    id = await insertFeedbackIn(tx, { ...prepared.values, dedupKey: input.dedupKey ?? null });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  if (created) embedFeedbackLater(id);
  return answer(projectId, id, actor, { created });
}

/** The decline act, reached from triage's decline route: the reason the reporter reads, a decision row. */
export async function declineIn(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  reason: string | undefined,
): Promise<NamedRefusal | null> {
  const refused = declineRefusal(row.status, reason);
  if (refused) return refused;
  await tx
    .update(feedback)
    .set({ status: 'declined', updatedAt: new Date() })
    .where(eq(feedback.id, row.id));
  await decide(tx, row, actor, { decision: 'declined', reason: reason ?? null });
  await closeClarification(tx, row.id, 'declined');
  return null;
}

async function personalAct(
  input: { projectId: string; ref: string; actor: FeedbackActor; note: string | undefined },
  act: 'verified' | 'reopened',
): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const forbidden = verifyActRefusal(
    await roleFacts(actor, projectId),
    projectId,
    act === 'verified' ? 'verifying feedback' : 'reopening feedback',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const phase = await phaseOfRow(projectId, row);
    const refused = act === 'verified' ? verifyRefusal(phase) : reopenRefusal(phase, input.note);
    if (refused) return [refused];
    await tx
      .update(feedback)
      .set({ status: act, updatedAt: new Date() })
      .where(eq(feedback.id, row.id));
    const onBehalf = actor.userId === row.reportedBy ? null : 'on behalf of the reporter';
    await decide(tx, row, actor, {
      decision: act,
      reason:
        [input.note?.trim(), act === 'verified' ? onBehalf : null].filter(Boolean).join(' · ') ||
        null,
    });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor);
}

/** The reporter, or a BA naming them, confirms the fix: never automatic, never an agent. */
export const verifyFeedback = (input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  note?: string | undefined;
}) => personalAct({ ...input, note: input.note }, 'verified');

/** The reporter says the fix does not answer it, with the reason; it goes back to triage. */
export const reopenFeedback = (input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  reason: string | undefined;
}) => personalAct({ ...input, note: input.reason }, 'reopened');

/**
 * UC15: a project admin person deletes what the reporter gave — the text, the attachments and
 * mockups with their bytes, the embedding, the clarification answers and the suggestion payloads
 * quoting it — and keeps the keyed row as a tombstone so every link to it still resolves.
 */
export async function redactReporterData(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const forbidden = redactActRefusal(await roleFacts(actor, projectId));
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  let paths: string[] = [];
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const done = redactedRefusal(row.redactedAt);
    if (done) return [done];
    const gone = await tx
      .delete(feedbackAttachments)
      .where(eq(feedbackAttachments.feedbackId, row.id))
      .returning({ path: feedbackAttachments.storagePath });
    paths = gone.map((g) => g.path);
    await tx.delete(itemEmbeddings).where(eq(itemEmbeddings.feedbackId, row.id));
    await tx.delete(agentQuestions).where(eq(agentQuestions.feedbackId, row.id));
    const now = new Date();
    const why = `reporter data of ${feedbackKey(row.fbSeq)} deleted`;
    await tx
      .update(suggestions)
      .set({ status: 'withdrawn', decidedAt: now, reason: why })
      .where(and(eq(suggestions.feedbackId, row.id), eq(suggestions.status, 'proposed')));
    await tx
      .update(suggestions)
      .set({ payload: null, payloadPurgedAt: now })
      .where(
        and(
          eq(suggestions.feedbackId, row.id),
          inArray(suggestions.status, ['rejected', 'stale', 'withdrawn']),
        ),
      );
    await tx
      .update(suggestions)
      .set({ payload: { redacted: true } })
      .where(and(eq(suggestions.feedbackId, row.id), eq(suggestions.status, 'accepted')));
    await tx
      .update(feedback)
      .set({
        title: `${feedbackKey(row.fbSeq)} (reporter data deleted)`,
        body: null,
        redactedAt: now,
        redactedBy: actor.userId,
        updatedAt: now,
      })
      .where(eq(feedback.id, row.id));
    const sketches = await tx
      .delete(mockups)
      .where(eq(mockups.feedbackId, row.id))
      .returning({ path: mockups.storagePath });
    paths.push(...sketches.map((g) => g.path));
    await decide(tx, row, actor, { decision: 'redacted' });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  const storage = getStorage();
  for (const path of paths) {
    await storage.delete(path).catch((err: unknown) => {
      logger.error(
        { err, projectId, feedbackId: first.id, path },
        'feedback: a redacted attachment was not removed from storage',
      );
    });
  }
  return answer(projectId, first.id, actor);
}
