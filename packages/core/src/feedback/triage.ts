/**
 * Triage (Feedback triage r16 `check` and `decide`; Feedback lifecycle r14 `triage-check`). The
 * triager answers the triage checklist and picks the route, or the short form gives it; triage checks
 * the answers and the route against the target, moves the item to triaged (or declined, the decline
 * act) and writes what carries the route, all in one transaction. The kernel judges the checklist on
 * the edge into triaged, alike at every door; an agent's `feedback_triage` suggestion reaches
 * `triageIn` from its accept, held to feedback.approve like a person's triage.
 */

import {
  FEEDBACK_SEVERITIES,
  type FeedbackSeverity,
  type FeedbackTriage,
  type FeedbackTriageEffect,
  type FeedbackTriageRoute,
  feedbackKey,
} from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import {
  namedCriterionOf,
  triageAnswersOf,
  triageDerivedOf,
  triageRouteOf,
} from '@forge/contracts/feedback-triage';
import { requirementKey } from '@forge/contracts/requirements';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { isRefusal, type Refusal } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { readRecording } from '../previews/index.js';
import { feedbackTriageRecord } from './checklist-record.js';
import { phaseOfRow } from './list-read.js';
import {
  type FeedbackActor,
  type Row,
  rowIn,
  type TargetRequirement,
  targetRequirementOf,
} from './read.js';
import { tellReporters } from './reporter-language.js';
import { duplicateNotice } from './reporter-notices.js';
import { reportersOf, tellStepToReporters, withBell } from './reporters.js';
import { NO_ROUTE, writeRouteIn } from './route-write.js';
import {
  carriersNamed,
  decideActRefusal,
  refusal,
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
import {
  answersShapeRefusal,
  criterionFitRefusal,
  criterionTextRefusal,
  type FoundCriterion,
  judgeRetriage,
  shortFormRouteRefusal,
} from './triage-checklist.js';

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
  await tx.update(feedback).set({ kind: row.kind }).where(eq(feedback.id, row.id));
  const refused = await declineIn(tx, row, actor, note);
  if (refused) return { refusals: [refused] };
  return {
    refusals: null,
    effect: { feedback: feedbackKey(row.fbSeq), route: 'decline', carriers: [] },
  };
}

/**
 * A diagnosis (REQ-41 BC-19) rides the issue route only, and names a recording of this very item
 * that still holds its timeline: the reproduction the cause was read from. Read as the triager,
 * so a recording they may not read is refused as unknown, never trusted.
 */
async function diagnosisRefusal(
  t: FeedbackTriage,
  route: FeedbackTriageRoute,
  row: Row,
  actor: FeedbackActor,
): Promise<Refusal | null> {
  const d = t.diagnosis;
  if (!d) return null;
  if (route !== 'issue') {
    return refusal(
      'FEEDBACK_DIAGNOSIS_INVALID',
      '/diagnosis',
      `a diagnosis is the cause and fix of a reproduced bug, carried by the issue that builds the fix: send it with route issue, not ${route}`,
    );
  }
  const key = feedbackKey(row.fbSeq);
  let recording: Awaited<ReturnType<typeof readRecording>>;
  try {
    recording = await readRecording(d.recording, actor);
  } catch (err) {
    if (!isRefusal(err)) throw err;
    const why = err.refusals.map((r) => r.detail).join('; ');
    return refusal(
      'FEEDBACK_DIAGNOSIS_INVALID',
      '/diagnosis/recording',
      `recording ${d.recording} cannot be read as ${key}'s reproduction (${why}): name a recording of ${key}`,
    );
  }
  if (recording.feedbackId !== row.id) {
    return refusal(
      'FEEDBACK_DIAGNOSIS_INVALID',
      '/diagnosis/recording',
      `recording ${d.recording} is a reproduction of another item, not ${key}: name a recording of ${key}`,
    );
  }
  if (recording.state === 'redacted') {
    return refusal(
      'FEEDBACK_DIAGNOSIS_INVALID',
      '/diagnosis/recording',
      `recording ${d.recording} was deleted with ${key}'s reporter data, so it evidences nothing: name a recording that stands`,
    );
  }
  return null;
}

/** What a diagnosis says on the item's history when the triager wrote no note of their own. */
const diagnosisNote = (t: FeedbackTriage): string | null =>
  t.diagnosis ? `Cause: ${t.diagnosis.cause} Fix: ${t.diagnosis.fix}` : null;

type Criterion = Extract<FoundCriterion, { found: true }> & { requirementStatus: string };

/** A `REQ-n BC-m` of this project, as it stands at its requirement's current revision. */
async function criterionIn(
  tx: Tx,
  projectId: string,
  named: { requirement: string; code: string },
): Promise<Criterion | { found: false }> {
  const seq = Number(named.requirement.slice('REQ-'.length));
  const rows = (await tx.execute(sql`
    SELECT c.id, r.id AS requirement_id, r.req_seq, r.status
      FROM requirement_criteria c
      JOIN requirements r ON r.id = c.requirement_id
     WHERE r.project_id = ${projectId} AND r.req_seq = ${seq} AND c.code = ${named.code}
       AND r.current_revision IS NOT NULL
       AND c.since_revision <= r.current_revision
       AND (c.retired_revision IS NULL OR c.retired_revision > r.current_revision)
     LIMIT 1
  `)) as unknown as Array<{ id: string; requirement_id: string; req_seq: number; status: string }>;
  const row = rows[0];
  if (!row) return { found: false };
  return {
    found: true,
    id: row.id,
    requirementId: row.requirement_id,
    requirementKey: requirementKey(Number(row.req_seq)),
    requirementStatus: row.status,
  };
}

/** The severity the answers give, where it is one; anything else is the checklist's to refuse. */
function severityAnswerOf(answers: unknown): FeedbackSeverity | null {
  const given =
    typeof answers === 'object' && answers !== null
      ? (answers as Record<string, unknown>).severity
      : undefined;
  return (FEEDBACK_SEVERITIES as readonly unknown[]).includes(given)
    ? (given as FeedbackSeverity)
    : null;
}

/** The checks a triage meets before anything is written: the answers' shape, the route and its carriers. */
async function earlyRefusal(
  t: FeedbackTriage,
  route: FeedbackTriageRoute | undefined,
  row: Row,
  actor: FeedbackActor,
): Promise<Refusal | null> {
  return (
    triagePhaseRefusal(await phaseOfRow(row.projectId, row), route) ??
    answersShapeRefusal(t.route, t.answers) ??
    criterionTextRefusal(t.answers) ??
    shortFormRouteRefusal(row.kind, t.answers, t.route) ??
    (route ? routeShapeRefusal(t, route) : null) ??
    (route ? await diagnosisRefusal(t, route, row, actor) : null)
  );
}

/**
 * The criterion the answers name, checked against the item: the requirement it is about is its
 * target's, else the criterion's, which the issue route then files the issue against.
 */
async function criterionAndTarget(
  tx: Tx,
  row: Row,
  answers: unknown,
): Promise<
  { refusal: Refusal } | { criterion: Criterion | null; target: TargetRequirement | null }
> {
  const own = await targetRequirementOf(tx, row);
  const named = namedCriterionOf(answers);
  if (!named) return { criterion: null, target: own };
  const found = await criterionIn(tx, row.projectId, named);
  const misfit = criterionFitRefusal(named, found, {
    key: feedbackKey(row.fbSeq),
    requirement: own,
  });
  if (misfit) return { refusal: misfit };
  const criterion = found as Criterion;
  return {
    criterion,
    target: own ?? {
      id: criterion.requirementId,
      key: criterion.requirementKey,
      status: criterion.requirementStatus,
    },
  };
}

/**
 * Triage inside the caller's transaction: the answers and the route are checked against the target,
 * the item moves to triaged through its checklist (or declined, the decline act), and what carries
 * the route is written in the same act.
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
  const kind = t.kind ?? input.row.kind;
  const route: FeedbackTriageRoute | undefined =
    t.route === 'decline' ? 'decline' : triageRouteOf({ kind, route: t.route, answers: t.answers });
  const early = await earlyRefusal(t, route, { ...input.row, kind }, actor);
  if (early) return { refusals: [early] };
  if (route === 'decline') return declineTriageIn(tx, { ...input.row, kind }, actor, t.note);
  const read = await criterionAndTarget(tx, { ...input.row, kind }, t.answers);
  if ('refusal' in read) return { refusals: [read.refusal] };
  const { criterion, target } = read;
  const row: Row = {
    ...input.row,
    kind,
    severity: severityAnswerOf(t.answers) ?? input.row.severity,
    violatedCriterionId: criterion?.id ?? null,
  };
  const rule = route
    ? routeRuleRefusal(route, {
        kind: row.kind,
        targetRequirement: target,
        suggestion: null,
        routedRequirement: null,
      })
    : null;
  if (rule) return { refusals: [rule] };
  await tx
    .update(feedback)
    .set({
      kind: row.kind,
      severity: row.severity,
      violatedCriterionId: row.violatedCriterionId,
      route: null,
      ...NO_ROUTE,
      ...NOT_SNOOZED,
      resolvedSeenAt: null,
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, row.id));
  await tx.delete(feedbackRouteIssues).where(eq(feedbackRouteIssues.feedbackId, row.id));
  // the route the triager sent is theirs; the one the short form gives is recorded as derived
  const sent = t.route === 'decline' ? undefined : t.route;
  const answers = triageAnswersOf({ route: sent, answers: t.answers });
  const derived = triageDerivedOf({ kind, route: sent, answers: t.answers });
  const firstTriage = row.status !== 'triaged';
  if (firstTriage) {
    const moved = await transition(tx, FEEDBACK_MACHINE, {
      to: 'triaged',
      expect: row.status,
      where: eq(feedback.id, row.id),
      actor: feedbackKernelActor(actor),
      source: 'feedback-triage',
      checklist: {
        answers,
        derived,
        record: ({ tx: lockTx }) => feedbackTriageRecord(lockTx, row.id),
      },
      returning: ['id'],
    });
    movedRow(moved);
  } else {
    const judged = judgeRetriage(answers, await feedbackTriageRecord(tx, row.id), derived);
    if ('refusals' in judged) return { refusals: judged.refusals };
  }
  // the checklist asks the route, so a triage that reaches here has one
  if (route === undefined)
    throw new Error(`feedback triage: ${row.id} passed its checklist with no route`);
  // an issue route naming no existing issue files a draft in the same act (feedback-triage r4 `issue`)
  const routed = { ...t, route };
  const write =
    route === 'issue' && carriersNamed(routed).length === 0
      ? { ...routed, createIssue: {} }
      : routed;
  const written = await writeRouteIn(tx, {
    row,
    route,
    write,
    target,
    actor,
    channel: input.channel,
    fromSuggestionId,
  });
  if ('refusals' in written) return { refusals: written.refusals };
  const carriers = written.carriers;
  if (route === 'duplicate') await tellDuplicateReporters(tx, row, carriers[0] ?? '');
  // a triage that moves the item tells its reporters where it went; a re-route moves no step
  else if (firstTriage)
    await tellStepToReporters(tx, row, 'triaged', actor.userId, carriers.join(', ') || null);
  await decide(tx, row, actor, {
    decision: 'triaged',
    route,
    carrier: carriers.length ? carriers.join(', ') : null,
    reason: t.note ?? diagnosisNote(t),
    fromSuggestionId,
  });
  await closeClarification(tx, row.id, `routed as ${route}`);
  return { refusals: null, effect: { feedback: feedbackKey(row.fbSeq), route, carriers } };
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
