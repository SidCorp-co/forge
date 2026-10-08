/**
 * Triage (workflow requirement-to-delivery steps `triage` and `route`; feedback-triage r4 `decide`).
 * A person picks the route; triage checks it against the target, moves the item to triaged or
 * declined and writes what carries the route, all in one transaction. An
 * agent's `feedback_triage` suggestion reaches `triageIn` from its accept, held to feedback.approve like a person's triage.
 */

import {
  type FeedbackTriage,
  type FeedbackTriageEffect,
  feedbackKey,
} from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { phaseOfRow } from './list-read.js';
import { type FeedbackActor, type Row, rowIn, targetRequirementOf } from './read.js';
import { tellReporters } from './reporter-language.js';
import { duplicateNotice } from './reporter-notices.js';
import { reportersOf, withBell } from './reporters.js';
import { NO_ROUTE, writeRouteIn } from './route-write.js';
import {
  carriersNamed,
  decideActRefusal,
  routeRuleRefusal,
  routeShapeRefusal,
  triagePhaseRefusal,
} from './rules.js';
import {
  answer,
  closeClarification,
  decide,
  declineIn,
  type FeedbackChannel,
  type FeedbackOutcome,
  feedbackKernelActor,
  inTx,
  lockFeedback,
  NOT_SNOOZED,
  roleFacts,
} from './service.js';

/** What a triage or a route write did, which its caller announces once the transaction committed. */
interface TriageWritten {
  refusals: Refusal[] | null;
  effect?: FeedbackTriageEffect;
}

async function declineTriageIn(
  tx: Tx,
  row: Row,
  actor: FeedbackActor,
  note: string | undefined,
): Promise<TriageWritten> {
  await tx
    .update(feedback)
    .set({ kind: row.kind, severity: row.severity })
    .where(eq(feedback.id, row.id));
  const refused = await declineIn(tx, row, actor, note);
  if (refused) return { refusals: [refused] };
  return {
    refusals: null,
    effect: { feedback: feedbackKey(row.fbSeq), route: 'decline', carriers: [] },
  };
}

/**
 * Triage inside the caller's transaction: the route is checked against the target, the item moves to
 * triaged (or declined, the decline act), and what carries the route is written in the same act.
 */
export async function triageIn(
  tx: Tx,
  input: {
    projectId: string;
    row: Row;
    triage: FeedbackTriage;
    actor: FeedbackActor;
    channel: FeedbackChannel;
    fromSuggestionId?: string | null;
  },
): Promise<TriageWritten> {
  const { projectId, triage: t, actor } = input;
  const fromSuggestionId = input.fromSuggestionId ?? null;
  const forbidden = decideActRefusal(await roleFacts(actor, projectId), 'picking a feedback route');
  if (forbidden) return { refusals: [forbidden] };
  await lockFeedback(tx, projectId);
  const early = triagePhaseRefusal(await phaseOfRow(projectId, input.row)) ?? routeShapeRefusal(t);
  if (early) return { refusals: [early] };
  const row: Row = {
    ...input.row,
    kind: t.kind ?? input.row.kind,
    severity: t.severity ?? input.row.severity,
  };
  const target = await targetRequirementOf(tx, row);
  const rule = routeRuleRefusal(t.route, {
    kind: row.kind,
    targetRequirement: target,
    suggestion: null,
    routedRequirement: null,
  });
  if (rule) return { refusals: [rule] };
  if (t.route === 'decline') return declineTriageIn(tx, row, actor, t.note);
  await tx
    .update(feedback)
    .set({
      kind: row.kind,
      severity: row.severity,
      route: null,
      ...NO_ROUTE,
      ...NOT_SNOOZED,
      resolvedSeenAt: null,
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, row.id));
  await tx.delete(feedbackRouteIssues).where(eq(feedbackRouteIssues.feedbackId, row.id));
  if (row.status !== 'triaged') {
    const moved = await transition(tx, FEEDBACK_MACHINE, {
      to: 'triaged',
      expect: row.status,
      where: eq(feedback.id, row.id),
      actor: feedbackKernelActor(actor),
      source: 'feedback-triage',
      returning: ['id'],
    });
    movedRow(moved);
  }
  // an issue route naming no existing issue files a draft in the same act (feedback-triage r4 `issue`)
  const write =
    t.route === 'issue' && carriersNamed(t).length === 0 ? { ...t, createIssue: {} } : t;
  const written = await writeRouteIn(tx, {
    row,
    route: t.route,
    write,
    target,
    actor,
    channel: input.channel,
    fromSuggestionId,
  });
  if ('refusals' in written) return { refusals: written.refusals };
  const carriers = written.carriers;
  if (t.route === 'duplicate') await tellDuplicateReporters(tx, row, carriers[0] ?? '');
  await decide(tx, row, actor, {
    decision: 'triaged',
    route: t.route,
    carrier: carriers.length ? carriers.join(', ') : null,
    reason: t.note ?? null,
    fromSuggestionId,
  });
  await closeClarification(tx, row.id, `routed as ${t.route}`);
  return { refusals: null, effect: { feedback: feedbackKey(row.fbSeq), route: t.route, carriers } };
}

/** An item merged into its original tells its own reporter, once, which item carries their report. */
async function tellDuplicateReporters(tx: Tx, row: Row, original: string) {
  const told = withBell((await reportersOf(tx, row)).filter((r) => r.from === null)).map(
    (r) => r.id,
  );
  await tellReporters(
    tx,
    { projectId: row.projectId, feedbackId: row.id, kind: 'duplicate' },
    told,
    (language) => duplicateNotice(language, feedbackKey(row.fbSeq), row.title, original),
  );
}

/** A holder of feedback.approve acts on one item under the feedback lock, then reads it back. */
export async function approvedActOn(
  input: { projectId: string; ref: string; actor: FeedbackActor },
  act: string,
  body: (tx: Tx, row: Row) => Promise<TriageWritten>,
): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const forbidden = decideActRefusal(await roleFacts(actor, projectId), act);
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  let written: TriageWritten = { refusals: null };
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    written = await body(tx, await rowIn(tx, projectId, first.id, true));
    return written.refusals;
  });
  if (refusals) return { ok: false, refusals };
  return answer(projectId, first.id, actor, written.effect ? { effect: written.effect } : {});
}

/** A holder of feedback.approve picks the route, an agent included (ADR 0007). */
export function triageFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  triage: FeedbackTriage;
  channel: FeedbackChannel;
}): Promise<FeedbackOutcome> {
  return approvedActOn(input, 'picking a feedback route', (tx, row) =>
    triageIn(tx, { ...input, row }),
  );
}
