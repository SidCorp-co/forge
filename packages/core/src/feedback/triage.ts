/**
 * Triage and the feedback case (workflow requirement-to-delivery steps `triage`, `fb-case` and
 * `route`; feedback-triage `decide`). Triage checks the route against the rule table, moves the item
 * to triaged or declined and opens its case in one transaction; the route is written in the same act
 * when triage names what carries it, else later by the case's owner through `routeFeedback`. An
 * agent's `feedback_triage` suggestion reaches `triageIn` from its accept.
 */

import {
  type FeedbackRouteWrite,
  type FeedbackTriage,
  type FeedbackTriageEffect,
  type FeedbackTriageRoute,
  feedbackKey,
} from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackCases } from '../db/schema-feedback.js';
import type { Refusal } from '../lib/refusal.js';
import { transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  type CaseRow,
  caseIn,
  type FeedbackActor,
  type Row,
  rowIn,
  targetRequirementOf,
} from './read.js';
import { NO_ROUTE, writeRouteIn } from './route.js';
import {
  carriersNamed,
  caseDueAt,
  caseOpenRefusal,
  caseOwnerOf,
  decideActRefusal,
  routeRuleRefusal,
  routeShapeRefusal,
  routeWriteShapeRefusal,
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
  roleFacts,
} from './service.js';
import { phaseOfRow } from './summary.js';

/** What a triage or a route write did, which its caller announces once the transaction committed. */
interface TriageWritten {
  refusals: Refusal[] | null;
  effect?: FeedbackTriageEffect;
}

async function openCaseIn(
  tx: Tx,
  row: Row,
  route: FeedbackTriageRoute,
  actor: FeedbackActor,
): Promise<CaseRow> {
  const now = new Date();
  const values = {
    route,
    owner: caseOwnerOf(route),
    openedBy: actor.userId,
    openedAgency: actor.agency,
    openedAt: now,
    dueAt: caseDueAt(row, now),
    routedAt: null,
    routedBy: null,
  };
  const [opened] = await tx
    .insert(feedbackCases)
    .values({ projectId: row.projectId, feedbackId: row.id, ...values })
    .onConflictDoUpdate({ target: feedbackCases.feedbackId, set: values })
    .returning();
  if (!opened) throw new Error('feedback_cases: the open returned no row');
  return opened;
}

async function markRoutedIn(tx: Tx, caseId: string, actor: FeedbackActor): Promise<void> {
  await tx
    .update(feedbackCases)
    .set({ routedAt: new Date(), routedBy: actor.userId })
    .where(eq(feedbackCases.id, caseId));
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
  await markRoutedIn(tx, (await openCaseIn(tx, row, 'decline', actor)).id, actor);
  return {
    refusals: null,
    effect: { feedback: feedbackKey(row.fbSeq), route: 'decline', carrier: null },
  };
}

/**
 * Triage inside the caller's transaction: the route is checked against the rule table, the item
 * moves to triaged (or declined, the decline act), its case opens, and the route is written at once
 * when the triage names what carries it.
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
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, row.id));
  await transition(tx, FEEDBACK_MACHINE, {
    to: 'triaged',
    where: eq(feedback.id, row.id),
    actor: feedbackKernelActor(actor),
    source: 'feedback-triage',
    returning: ['id'],
  });
  const kase = await openCaseIn(tx, row, t.route, actor);
  let carrier: string | null = null;
  if (carriersNamed(t).length > 0) {
    const route = t.route;
    const written = await writeRouteIn(tx, {
      row,
      route,
      write: t,
      target,
      actor,
      channel: input.channel,
      fromSuggestionId,
    });
    if ('refusals' in written) return { refusals: written.refusals };
    carrier = written.carrier;
    await markRoutedIn(tx, kase.id, actor);
  }
  await decide(tx, row, actor, {
    decision: 'triaged',
    route: t.route,
    carrier,
    reason: t.note ?? null,
    fromSuggestionId,
  });
  await closeClarification(tx, row.id, `routed as ${t.route}`);
  return { refusals: null, effect: { feedback: feedbackKey(row.fbSeq), route: t.route, carrier } };
}

/** A holder of feedback.approve acts on one item under the feedback lock, then reads it back. */
async function approvedActOn(
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

/** The case's owner writes what carries the route triage decided (step `route`). */
export function routeFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  write: FeedbackRouteWrite;
  channel: FeedbackChannel;
}): Promise<FeedbackOutcome> {
  const { projectId, actor, write } = input;
  return approvedActOn(input, "writing a feedback case's route", async (tx, row) => {
    const kase = await caseIn(tx, row.id);
    const closed = caseOpenRefusal(kase, await phaseOfRow(projectId, row));
    if (closed) return { refusals: [closed] };
    if (!kase || kase.route === 'decline') {
      throw new Error(`feedback_cases: ${row.id} reads open with no route left to write`);
    }
    const shape = routeWriteShapeRefusal(kase.route, write);
    if (shape) return { refusals: [shape] };
    const done = await writeRouteIn(tx, {
      row,
      route: kase.route,
      write,
      target: await targetRequirementOf(tx, row),
      actor,
      channel: input.channel,
      fromSuggestionId: null,
    });
    if ('refusals' in done) return { refusals: done.refusals };
    await markRoutedIn(tx, kase.id, actor);
    await decide(tx, row, actor, {
      decision: 'routed',
      route: kase.route,
      carrier: done.carrier,
      reason: write.note ?? null,
    });
    return {
      refusals: null,
      effect: { feedback: feedbackKey(row.fbSeq), route: kase.route, carrier: done.carrier },
    };
  });
}
