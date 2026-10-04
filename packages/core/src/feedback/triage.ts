/**
 * Triage, the feedback case and the route write (workflow requirement-to-delivery r2 steps `triage`,
 * `fb-case` and `route`; feedback-triage r3 `decide`). Triage checks the route against the rule
 * table, moves the item to triaged or declined and opens its case in one transaction; the route is
 * written in the same act when triage names what carries it, else later by the case's owner through
 * `routeFeedback`. An agent's `feedback_triage` suggestion reaches `triageIn` from its accept.
 */

import type {
  FeedbackRouteWrite,
  FeedbackTriage,
  FeedbackTriageEffect,
  FeedbackTriageRoute,
} from '@forge/contracts/feedback';
import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackCases } from '../db/schema-feedback.js';
import { announceIssueCreated, insertIssueRow } from '../issues/create-service.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { findIssueById } from '../issues/read-service.js';
import { writeRecordEvent } from '../issues/record-events/store.js';
import { assertProjectAccess } from '../lib/authz.js';
import { dataPolicyOf, egressAt, storedText } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { NamedRefusal } from '../project-config/respond.js';
import { requirementKey, rowIn as requirementRowIn } from '../requirements/read.js';
import { linkIssueRefusal } from '../requirements/rules.js';
import { createRequirementIn, lockRequirements } from '../requirements/service.js';
import { rowOf as suggestionRowOf } from '../suggestions/read.js';
import {
  type CaseRow,
  caseIn,
  duplicateKeysOf,
  type FeedbackActor,
  feedbackKey,
  phaseOfRow,
  type Row,
  rowIn,
  type TargetRequirement,
  targetRequirementOf,
} from './read.js';
import { isRefusal, issueRefIn, requirementRefIn } from './refs.js';
import {
  carriersNamed,
  caseDueAt,
  caseOpenRefusal,
  caseOwnerOf,
  decideActRefusal,
  duplicateRefusal,
  type RouteFacts,
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
  inTx,
  lockFeedback,
  roleFacts,
} from './service.js';

/** What a triage or a route write did, which its caller announces once the transaction committed. */
export interface TriageWritten {
  refusals: NamedRefusal[] | null;
  effect?: FeedbackTriageEffect;
  createdIssueId?: string;
}

type CarriedRoute = Exclude<FeedbackTriageRoute, 'decline'>;

type RouteColumns = Pick<
  typeof feedback.$inferInsert,
  'routedIssueId' | 'routedRequirementId' | 'routedSuggestionId' | 'duplicateOf' | 'answer'
>;

const NO_ROUTE: RouteColumns = {
  routedIssueId: null,
  routedRequirementId: null,
  routedSuggestionId: null,
  duplicateOf: null,
  answer: null,
};

interface Carrier {
  columns: RouteColumns;
  key: string | null;
  facts: Pick<RouteFacts, 'suggestion' | 'routedRequirement'>;
}

interface RouteInput {
  row: Row;
  route: CarriedRoute;
  write: FeedbackRouteWrite;
  target: TargetRequirement | null;
  actor: FeedbackActor;
  channel: FeedbackChannel;
  fromSuggestionId: string | null;
}

const unknownCarrier = (path: string, detail: string): NamedRefusal => ({
  code: 'FEEDBACK_TARGET_UNKNOWN',
  path,
  detail,
});

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

/** An existing carrier the write names, resolved inside the item's project. */
async function namedCarrierIn(
  tx: Tx,
  input: RouteInput,
): Promise<{ refusal: NamedRefusal } | Carrier> {
  const { row, route, write: w, actor } = input;
  const projectId = row.projectId;
  const none: Carrier = {
    columns: NO_ROUTE,
    key: null,
    facts: { suggestion: null, routedRequirement: null },
  };
  if (route === 'issue' && w.issue) {
    const issue = await issueRefIn(projectId, w.issue, actor.userId, '/issue');
    if (isRefusal(issue)) return { refusal: issue };
    return { ...none, columns: { ...NO_ROUTE, routedIssueId: issue.id }, key: issue.key };
  }
  if (route === 'revision' && w.suggestion) {
    const s = await suggestionRowOf(tx, projectId, w.suggestion).catch((err: unknown) => {
      if (err instanceof HTTPException && err.status === 404) return null;
      throw err;
    });
    if (!s) {
      return {
        refusal: unknownCarrier(
          '/suggestion',
          `${w.suggestion} names no suggestion of this project.`,
        ),
      };
    }
    return {
      columns: { ...NO_ROUTE, routedSuggestionId: s.id },
      key: s.id,
      facts: { suggestion: { kind: s.kind, requirementId: s.requirementId }, routedRequirement: null },
    };
  }
  if (route === 'new_requirement' && w.requirement) {
    const req = await requirementRefIn(projectId, w.requirement, '/requirement');
    if (isRefusal(req)) return { refusal: req };
    return {
      columns: { ...NO_ROUTE, routedRequirementId: req.id },
      key: req.key,
      facts: { suggestion: null, routedRequirement: { key: req.key, status: req.status } },
    };
  }
  if (route === 'answer') {
    const text = storedText(await dataPolicyOf(projectId), (w.answer ?? '').trim()).text;
    return { ...none, columns: { ...NO_ROUTE, answer: text } };
  }
  if (route === 'duplicate' && w.duplicateOf) {
    const root = await rowIn(tx, projectId, w.duplicateOf);
    const rootOf = root.duplicateOf ? await rowIn(tx, projectId, root.duplicateOf) : null;
    const chain = duplicateRefusal(
      row.id,
      {
        id: root.id,
        key: feedbackKey(root.fbSeq),
        duplicateOfKey: rootOf ? feedbackKey(rootOf.fbSeq) : null,
      },
      await duplicateKeysOf(tx, row.id),
    );
    if (chain) return { refusal: chain };
    return {
      ...none,
      columns: { ...NO_ROUTE, duplicateOf: root.id },
      key: feedbackKey(root.fbSeq),
    };
  }
  return none;
}

/** A bug's issue, or a contract change's upgrade issue due by the provider's commitment window. */
async function fileIssueIn(tx: Tx, input: RouteInput): Promise<{ id: string; key: string }> {
  const { row, write: w, target, actor } = input;
  const key = feedbackKey(row.fbSeq);
  // an issue is product content every agent reads, so the reporter's text is copied in only as the
  // feedback egress surface allows: at no_egress the issue carries the reference alone
  const copied = egressAt(
    await dataPolicyOf(row.projectId),
    'feedback',
    { title: row.title, body: row.body ?? '' },
    key,
  );
  const due =
    row.kind === 'contract_change' && row.dueAt
      ? `Due by ${row.dueAt.toISOString().slice(0, 10)}, the end of the provider's commitment window.`
      : null;
  const carried = copied.ok
    ? [`Carries ${key}: ${copied.value.title}`, due, copied.value.body]
    : [
        `Carries ${key}. Its content stays in Forge under this project's no_egress policy; read it on the Feedback page.`,
        due,
      ];
  const linkable =
    target && !linkIssueRefusal(target.status as Parameters<typeof linkIssueRefusal>[0]);
  const issue = await insertIssueRow(tx, {
    projectId: row.projectId,
    title: w.createIssue?.title ?? (copied.ok ? copied.value.title : `Feedback ${key}`),
    description: w.createIssue?.description ?? carried.filter(Boolean).join('\n\n'),
    descriptionFormat: 'markdown',
    status: 'draft',
    priority: row.severity,
    category: row.kind === 'bug' ? 'bug' : 'feature',
    createdById: actor.userId,
    createdByDeviceId: null,
    createdVia: input.channel,
    requirementId: linkable ? target.id : null,
    fromSuggestionId: input.fromSuggestionId,
  });
  return {
    id: issue.id,
    key: formatIssueRef(await activeIssuePrefix(row.projectId), issue.issSeq),
  };
}

/**
 * Writes what carries the route inside the caller's transaction: a named carrier is resolved, the
 * rule table checked against it, a carrier triage asks for is filed, and the route columns set.
 */
async function writeRouteIn(
  tx: Tx,
  input: RouteInput,
): Promise<{ refusals: NamedRefusal[] } | { carrier: string | null; createdIssueId?: string }> {
  const { row, route, write: w, actor } = input;
  const named = await namedCarrierIn(tx, input);
  if ('refusal' in named) return { refusals: [named.refusal] };
  const fit = routeRuleRefusal(route, {
    kind: row.kind,
    targetRequirement: input.target,
    ...named.facts,
  });
  if (fit) return { refusals: [fit] };
  let { columns, key } = named;
  let createdIssueId: string | undefined;
  if (route === 'issue' && w.createIssue) {
    const filed = await fileIssueIn(tx, input);
    createdIssueId = filed.id;
    columns = { ...NO_ROUTE, routedIssueId: filed.id };
    key = filed.key;
  }
  if (route === 'new_requirement' && w.title) {
    await lockRequirements(tx, row.projectId);
    const created = await createRequirementIn(tx, {
      projectId: row.projectId,
      actor,
      title: w.title,
      write: { reason: `Started from ${feedbackKey(row.fbSeq)}`, criteria: [] },
    });
    if (created.refusals?.length) return { refusals: created.refusals };
    const req = await requirementRowIn(tx, row.projectId, created.id);
    columns = { ...NO_ROUTE, routedRequirementId: req.id };
    key = requirementKey(req.reqSeq);
  }
  await tx
    .update(feedback)
    .set({ route, ...columns, updatedAt: new Date() })
    .where(eq(feedback.id, row.id));
  if (columns.routedIssueId) {
    await writeRecordEvent(
      {
        issueId: columns.routedIssueId,
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
  return { carrier: key, ...(createdIssueId ? { createdIssueId } : {}) };
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
  const key = feedbackKey(row.fbSeq);
  if (t.route === 'decline') {
    await tx
      .update(feedback)
      .set({ kind: row.kind, severity: row.severity })
      .where(eq(feedback.id, row.id));
    const refused = await declineIn(tx, row, actor, t.note);
    if (refused) return { refusals: [refused] };
    await markRoutedIn(tx, (await openCaseIn(tx, row, 'decline', actor)).id, actor);
    return { refusals: null, effect: { feedback: key, route: 'decline', carrier: null } };
  }
  await tx
    .update(feedback)
    .set({
      status: 'triaged',
      kind: row.kind,
      severity: row.severity,
      route: null,
      ...NO_ROUTE,
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
  const issue = await findIssueById(written.createdIssueId);
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
    projectId,
    'picking a feedback route',
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  let written: TriageWritten = { refusals: null };
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    written = await triageIn(tx, {
      projectId,
      row: await rowIn(tx, projectId, first.id, true),
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
  const forbidden = decideActRefusal(
    await roleFacts(actor, projectId),
    projectId,
    "writing a feedback case's route",
  );
  if (forbidden) return { ok: false, refusals: [forbidden] };
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
    const shape = routeWriteShapeRefusal(kase.route, write);
    if (shape) return [shape];
    const done = await writeRouteIn(tx, {
      row,
      route: kase.route,
      write,
      target: await targetRequirementOf(tx, row),
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
