/**
 * Triage and the feedback case (workflow requirement-to-delivery steps `triage`, `fb-case` and
 * `route`; feedback-triage r3 `decide`): a person picks the route by the rule table, or accepts an
 * agent's `feedback_triage` suggestion, whose accept calls `triageIn` inside its own transaction.
 * Triage opens the item's case; the case's owner writes what carries the route, in the same act when
 * triage names it, or later through `routeFeedback`. A route onto an issue is a typed record event
 * on that issue.
 */

import type {
  FeedbackRouteWrite,
  FeedbackTriage,
  FeedbackTriageEffect,
  FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { announceIssueCreated, insertIssueRow } from '../issues/create-service.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import { assertProjectAccess } from '../lib/authz.js';
import { dataPolicyOf, egressAt, storedText } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { requirementKey } from '../requirements/read.js';
import { linkIssueRefusal } from '../requirements/rules.js';
import { createRequirementIn, lockRequirements } from '../requirements/service.js';
import { caseIn, markRoutedIn, openCaseIn } from './case.js';
import { type FeedbackActor, feedbackKey, phaseOfRow, type Row, rowIn } from './read.js';
import { isRefusal, issueRefIn, requirementRefIn } from './refs.js';
import {
  carriersNamed,
  caseOpenRefusal,
  duplicateRefusal,
  type RouteFacts,
  routeRuleRefusal,
  routeShapeRefusal,
  routeWriteShapeRefusal,
  triagePhaseRefusal,
} from './route-rules.js';
import { decideActRefusal } from './rules.js';
import {
  answer,
  closeClarification,
  decide,
  declineIn,
  type FeedbackChannel,
  type FeedbackOutcome,
  inTx,
  lockFeedback,
  roleFacts,
} from './service.js';

/** What a triage filed that its caller announces once the transaction committed. */
export interface TriageWritten {
  refusals: NamedRefusal[] | null;
  effect?: FeedbackTriageEffect;
  createdIssueId?: string;
}

type TargetRequirement = RouteFacts['targetRequirement'];

/** The requirement an item is about: its target, or the requirement its target issue delivers. */
async function targetRequirementIn(tx: Tx, row: Row): Promise<TargetRequirement> {
  let id = row.requirementId;
  if (!id && row.issueId) {
    const [i] = await tx
      .select({ requirementId: issues.requirementId })
      .from(issues)
      .where(eq(issues.id, row.issueId));
    id = i?.requirementId ?? null;
  }
  if (!id) return null;
  const [req] = await tx
    .select({ id: requirements.id, seq: requirements.reqSeq, status: requirements.status })
    .from(requirements)
    .where(eq(requirements.id, id));
  return req ? { id: req.id, key: requirementKey(req.seq), status: req.status } : null;
}

async function fileDraftIssue(
  tx: Tx,
  row: Row,
  w: FeedbackRouteWrite,
  target: TargetRequirement,
  actor: FeedbackActor,
  channel: FeedbackChannel,
  fromSuggestionId: string | null,
): Promise<string> {
  const key = feedbackKey(row.fbSeq);
  // cm:guard an issue is product content every agent reads, so the reporter's operational text is
  // copied into it only as the one egress rule lets feedback leave (surface `feedback`): at
  // no_egress the issue carries the reference only, in its title and its body alike
  const copied = egressAt(
    await dataPolicyOf(row.projectId),
    'feedback',
    { title: row.title, body: row.body ?? '' },
    key,
  );
  // a contract change is the consumer's upgrade issue, due by the provider's commitment window
  const due =
    row.kind === 'contract_change' && row.dueAt
      ? `Due by ${row.dueAt.toISOString().slice(0, 10)}, the end of the provider's commitment window.`
      : null;
  const carried = copied.ok
    ? [`Carries ${key}: ${copied.value.title}`, due, copied.value.body].filter(Boolean).join('\n\n')
    : [
        `Carries ${key}. Its content stays in Forge under this project's no_egress policy; read it on the Feedback page.`,
        due,
      ]
        .filter(Boolean)
        .join('\n\n');
  const requirementId =
    target && !linkIssueRefusal(target.status as Parameters<typeof linkIssueRefusal>[0])
      ? target.id
      : null;
  const issue = await insertIssueRow(tx, {
    projectId: row.projectId,
    title: w.createIssue?.title ?? (copied.ok ? copied.value.title : `Feedback ${key}`),
    description: w.createIssue?.description ?? carried,
    descriptionFormat: 'markdown',
    status: 'draft',
    priority: row.severity,
    category: row.kind === 'bug' ? 'bug' : 'feature',
    createdById: actor.userId,
    createdByDeviceId: null,
    createdVia: channel,
    requirementId,
    fromSuggestionId,
  });
  return issue.id;
}

/**
 * Writes what carries `route` inside the caller's transaction: the carrier is resolved or filed and
 * checked against the item, and the route columns set. Refusals roll the caller back.
 */
async function writeRouteIn(
  tx: Tx,
  input: {
    row: Row;
    route: Exclude<FeedbackTriageRoute, 'decline'>;
    write: FeedbackRouteWrite;
    target: TargetRequirement;
    actor: FeedbackActor;
    channel: FeedbackChannel;
    fromSuggestionId: string | null;
  },
): Promise<{ refusals: NamedRefusal[] } | { carrier: string | null; createdIssueId?: string }> {
  const { row, route, write: w, actor } = input;
  const projectId = row.projectId;
  const set: Partial<typeof feedback.$inferInsert> = {
    route,
    routedIssueId: null,
    routedRequirementId: null,
    routedSuggestionId: null,
    duplicateOf: null,
    answer: null,
  };
  let carrier: string | null = null;
  let suggestionFacts: RouteFacts['suggestion'] = null;
  let routedRequirement: RouteFacts['routedRequirement'] = null;
  let createdIssueId: string | undefined;
  if (route === 'issue' && w.issue) {
    const issue = await issueRefIn(projectId, w.issue, actor.userId, '/issue');
    if (isRefusal(issue)) return { refusals: [issue] };
    set.routedIssueId = issue.id;
    carrier = issue.key;
  }
  if (route === 'revision' && w.suggestion) {
    const [s] = await tx
      .select({
        id: suggestions.id,
        kind: suggestions.kind,
        requirementId: suggestions.requirementId,
      })
      .from(suggestions)
      .where(and(eq(suggestions.id, w.suggestion), eq(suggestions.projectId, projectId)));
    if (!s) {
      return {
        refusals: [
          {
            code: 'FEEDBACK_TARGET_UNKNOWN',
            path: '/suggestion',
            detail: `project ${projectId} holds no suggestion ${w.suggestion}.`,
          },
        ],
      };
    }
    suggestionFacts = { kind: s.kind, requirementId: s.requirementId };
    set.routedSuggestionId = s.id;
    carrier = s.id;
  }
  if (route === 'new_requirement' && w.requirement) {
    const req = await requirementRefIn(projectId, w.requirement, '/requirement');
    if (isRefusal(req)) return { refusals: [req] };
    routedRequirement = { key: req.key, status: req.status };
    set.routedRequirementId = req.id;
    carrier = req.key;
  }
  if (route === 'answer') {
    set.answer = storedText(await dataPolicyOf(projectId), (w.answer ?? '').trim()).text;
  }
  if (route === 'duplicate' && w.duplicateOf) {
    const root = await rowIn(tx, projectId, w.duplicateOf);
    const rootOf = root.duplicateOf ? await rowIn(tx, projectId, root.duplicateOf) : null;
    const pointing = await tx
      .select({ seq: feedback.fbSeq })
      .from(feedback)
      .where(eq(feedback.duplicateOf, row.id));
    const chain = duplicateRefusal(
      row.id,
      {
        id: root.id,
        key: feedbackKey(root.fbSeq),
        duplicateOfKey: rootOf ? feedbackKey(rootOf.fbSeq) : null,
      },
      pointing.map((p) => feedbackKey(p.seq)),
    );
    if (chain) return { refusals: [chain] };
    set.duplicateOf = root.id;
    carrier = feedbackKey(root.fbSeq);
  }
  const fit = routeRuleRefusal(route, {
    kind: row.kind,
    targetRequirement: input.target,
    suggestion: suggestionFacts,
    routedRequirement,
  });
  if (fit) return { refusals: [fit] };
  if (route === 'issue' && w.createIssue) {
    createdIssueId = await fileDraftIssue(
      tx,
      row,
      w,
      input.target,
      actor,
      input.channel,
      input.fromSuggestionId,
    );
    set.routedIssueId = createdIssueId;
    const [n] = await tx
      .select({ seq: issues.issSeq })
      .from(issues)
      .where(eq(issues.id, createdIssueId));
    carrier = n ? formatIssueRef(await activeIssuePrefix(projectId), n.seq) : createdIssueId;
  }
  if (route === 'new_requirement' && w.title) {
    await lockRequirements(tx, projectId);
    const created = await createRequirementIn(tx, {
      projectId,
      actor,
      title: w.title,
      write: { reason: `Started from ${feedbackKey(row.fbSeq)}`, criteria: [] },
    });
    if (created.refusals?.length) return { refusals: created.refusals };
    const [req] = await tx
      .select({ seq: requirements.reqSeq })
      .from(requirements)
      .where(eq(requirements.id, created.id));
    set.routedRequirementId = created.id;
    carrier = req ? requirementKey(req.seq) : created.id;
  }
  await tx
    .update(feedback)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(feedback.id, row.id));
  if (set.routedIssueId) {
    await writeRecordEvent(
      {
        issueId: set.routedIssueId,
        actor: { type: 'user', id: actor.userId, agency: actor.agency },
        kind: 'decision',
        contract: 1,
        fields: [
          { key: 'lead', value: `${feedbackKey(row.fbSeq)} routed to this issue` },
          { key: 'feedback', value: feedbackKey(row.fbSeq) },
          { key: 'outcome', value: createdIssueId ? 'filed' : 'linked' },
        ],
      },
      tx,
    );
  }
  return { carrier, ...(createdIssueId ? { createdIssueId } : {}) };
}

/**
 * Triage inside the caller's transaction, which holds the project's feedback lock: the route is
 * checked against the rule table, the item moves to triaged (or declined), its case opens, and the
 * route is written at once when the triage names what carries it.
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
  const phase = await phaseOfRow(projectId, input.row);
  const early = triagePhaseRefusal(phase) ?? routeShapeRefusal(t);
  if (early) return { refusals: [early] };
  const row: Row = {
    ...input.row,
    kind: t.kind ?? input.row.kind,
    severity: t.severity ?? input.row.severity,
  };
  const target = await targetRequirementIn(tx, row);
  const rule = routeRuleRefusal(t.route, {
    kind: row.kind,
    targetRequirement: target,
    suggestion: null,
    routedRequirement: null,
  });
  if (rule) return { refusals: [rule] };
  const key = feedbackKey(row.fbSeq);
  if (t.route === 'decline') {
    await tx
      .update(feedback)
      .set({ kind: row.kind, severity: row.severity })
      .where(eq(feedback.id, row.id));
    const refused = await declineIn(tx, row, actor, t.note);
    if (refused) return { refusals: [refused] };
    const kase = await openCaseIn(tx, row, 'decline', actor);
    await markRoutedIn(tx, kase.id, actor);
    return { refusals: null, effect: { feedback: key, route: 'decline', carrier: null } };
  }
  await tx
    .update(feedback)
    .set({
      status: 'triaged',
      kind: row.kind,
      severity: row.severity,
      route: null,
      routedIssueId: null,
      routedRequirementId: null,
      routedSuggestionId: null,
      duplicateOf: null,
      answer: null,
      updatedAt: new Date(),
    })
    .where(eq(feedback.id, row.id));
  const kase = await openCaseIn(tx, row, t.route, actor);
  let carrier: string | null = null;
  let createdIssueId: string | undefined;
  if (carriersNamed(t).length > 0) {
    const written = await writeRouteIn(tx, {
      row,
      route: t.route,
      write: t,
      target,
      actor,
      channel: input.channel,
      fromSuggestionId: input.fromSuggestionId ?? null,
    });
    if ('refusals' in written) return { refusals: written.refusals };
    carrier = written.carrier;
    createdIssueId = written.createdIssueId;
    await markRoutedIn(tx, kase.id, actor);
  }
  await decide(tx, row, actor, {
    decision: 'triaged',
    route: t.route,
    carrier,
    reason: t.note ?? null,
    fromSuggestionId: input.fromSuggestionId ?? null,
  });
  await closeClarification(tx, row.id, `routed as ${t.route}`);
  return {
    refusals: null,
    effect: { feedback: key, route: t.route, carrier },
    ...(createdIssueId ? { createdIssueId } : {}),
  };
}

/** After the transaction that filed a draft issue committed: the hook every issue create emits. */
export async function announceTriage(written: TriageWritten, actor: FeedbackActor) {
  if (!written.createdIssueId) return;
  const [issue] = await db.select().from(issues).where(eq(issues.id, written.createdIssueId));
  if (!issue) return;
  await announceIssueCreated(issue, { type: 'user', id: actor.userId, agency: actor.agency });
}

/** A holder of feedback.approve picks the route, an agent included (ADR 0007). */
export async function triageFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  triage: FeedbackTriage;
  channel: FeedbackChannel;
}): Promise<FeedbackOutcome> {
  const { projectId, actor } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const forbidden = decideActRefusal(
    await roleFacts(actor, projectId),
    'picking a feedback route',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  let written: TriageWritten = { refusals: null };
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    written = await triageIn(tx, {
      projectId,
      row,
      triage: input.triage,
      actor,
      channel: input.channel,
    });
    return written.refusals;
  });
  if (refusals) return { ok: false, refusals };
  await announceTriage(written, actor);
  return answer(projectId, first.id, actor, written.effect ? { effect: written.effect } : {});
}

/** The case's owner writes what carries the route triage decided (step `route`). */
export async function routeFeedback(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  write: FeedbackRouteWrite;
  channel: FeedbackChannel;
}): Promise<FeedbackOutcome> {
  const { projectId, actor, write } = input;
  await assertProjectAccess(projectId, actor.userId, 'viewer');
  const facts = await roleFacts(actor, projectId);
  const first = await rowIn(db, projectId, input.ref);
  let written: TriageWritten = { refusals: null };
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    const kase = await caseIn(tx, row.id);
    const closed = caseOpenRefusal(kase, await phaseOfRow(projectId, row));
    if (closed) return [closed];
    if (!kase || kase.route === 'decline') {
      throw new Error(`feedback_cases: ${row.id} reads open with no route left to write`);
    }
    const early =
      decideActRefusal(facts, "writing a feedback case's route") ??
      routeWriteShapeRefusal(kase.route, write);
    if (early) return [early];
    const done = await writeRouteIn(tx, {
      row,
      route: kase.route,
      write,
      target: await targetRequirementIn(tx, row),
      actor,
      channel: input.channel,
      fromSuggestionId: null,
    });
    if ('refusals' in done) return done.refusals;
    await markRoutedIn(tx, kase.id, actor);
    await decide(tx, row, actor, {
      decision: 'routed',
      route: kase.route,
      carrier: done.carrier,
      reason: write.note ?? null,
    });
    written = {
      refusals: null,
      effect: { feedback: feedbackKey(row.fbSeq), route: kase.route, carrier: done.carrier },
      ...(done.createdIssueId ? { createdIssueId: done.createdIssueId } : {}),
    };
    return null;
  });
  if (refusals) return { ok: false, refusals };
  await announceTriage(written, actor);
  return answer(projectId, first.id, actor, written.effect ? { effect: written.effect } : {});
}
