/**
 * Triage (workflow requirement-to-delivery steps `triage` and `route`; feedback-triage r4 `decide`).
 * A person picks the route; triage checks it against the target, moves the item to triaged or
 * declined and writes what carries the route, all in one transaction. An
 * agent's `feedback_triage` suggestion reaches `triageIn` from its accept, held to feedback.approve like a person's triage.
 */

import {
  type FeedbackTriage,
  type FeedbackTriageEffect,
  type FeedbackTriageRoute,
  feedbackKey,
} from '@forge/contracts/feedback';
import { FEEDBACK_MACHINE } from '@forge/contracts/feedback-machine';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { suggestions } from '../db/schema-suggestions.js';
import {
  activeIssuePrefix,
  insertContractWaitIn,
  insertIssueRow,
  liveWaitOn,
  writeRecordEvent,
} from '../issues/index.js';
import { dataPolicyOf, egressAt, storedText } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  createRequirementIn,
  linkIssueRefusal,
  lockRequirements,
  rowIn as requirementRowIn,
} from '../requirements/index.js';
import { phaseOfRow } from './list-read.js';
import {
  duplicateKeysOf,
  type FeedbackActor,
  type Row,
  rowIn,
  type TargetRequirement,
  targetRequirementOf,
} from './read.js';
import { isRefusal, issueRefIn, requirementRefIn } from './refs.js';
import {
  carriersNamed,
  decideActRefusal,
  duplicateRefusal,
  type RouteFacts,
  routeRuleRefusal,
  routeShapeRefusal,
  triagePhaseRefusal,
  upgradeTargetRefusal,
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

/** The route write (step `route`): a named carrier is resolved and checked against the target, a carrier triage asks for is filed, and the route columns set. */

type CarriedRoute = Exclude<FeedbackTriageRoute, 'decline'>;

type RouteColumns = Pick<
  typeof feedback.$inferInsert,
  'routedRequirementId' | 'routedSuggestionId' | 'duplicateOf' | 'answer'
>;

const NO_ROUTE: RouteColumns = {
  routedRequirementId: null,
  routedSuggestionId: null,
  duplicateOf: null,
  answer: null,
};

/** An issue carrying the route; `path` is where the triage named it, absent for one it filed. */
type CarrierIssue = { id: string; key: string; status: string; path?: string };

interface Carrier {
  columns: RouteColumns;
  /** What carries the route by key: every issue of an issue route, the one carrier of another. */
  keys: string[];
  facts: Pick<RouteFacts, 'suggestion' | 'routedRequirement'>;
  /** The issues an issue route carries on, each of which a contract change's wait is written on. */
  issues: CarrierIssue[];
}

interface RouteInput {
  row: Row;
  route: CarriedRoute;
  write: FeedbackTriage;
  target: TargetRequirement | null;
  actor: FeedbackActor;
  channel: FeedbackChannel;
  fromSuggestionId: string | null;
}

const unknownCarrier = (path: string, detail: string): Refusal => ({
  code: 'FEEDBACK_TARGET_UNKNOWN',
  path,
  detail,
});

/**
 * The issues an issue route names, each resolved inside the item's project: one ref answers at
 * `/issue`, a list at `/issue/<n>`, and one issue named twice (by key and uuid alike) is refused.
 */
async function namedIssuesIn(
  projectId: string,
  named: string | string[],
  userId: string,
): Promise<{ refusal: Refusal } | CarrierIssue[]> {
  const refs = typeof named === 'string' ? [named] : named;
  const out: CarrierIssue[] = [];
  for (const [n, ref] of refs.entries()) {
    const path = typeof named === 'string' ? '/issue' : `/issue/${n}`;
    const issue = await issueRefIn(projectId, ref, userId, path);
    if (isRefusal(issue)) return { refusal: issue };
    const twin = out.findIndex((o) => o.id === issue.id);
    if (twin >= 0) {
      return {
        refusal: {
          code: 'FEEDBACK_CARRIER_REPEATED',
          path,
          detail: `${ref} names ${issue.key}, which /issue/${twin} already names; an issue carries the route once, so name each issue one time.`,
        },
      };
    }
    out.push({ ...issue, path });
  }
  return out;
}

/** An existing carrier the write names, resolved inside the item's project. */
async function namedCarrierIn(tx: Tx, input: RouteInput): Promise<{ refusal: Refusal } | Carrier> {
  const { row, route, write: w, actor } = input;
  const projectId = row.projectId;
  const none: Carrier = {
    columns: NO_ROUTE,
    keys: [],
    facts: { suggestion: null, routedRequirement: null },
    issues: [],
  };
  if (route === 'issue' && w.issue) {
    const issues = await namedIssuesIn(projectId, w.issue, actor.userId);
    if ('refusal' in issues) return issues;
    return { ...none, keys: issues.map((i) => i.key), issues };
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
        refusal: unknownCarrier(
          '/suggestion',
          `${w.suggestion} names no suggestion of this project.`,
        ),
      };
    }
    return {
      ...none,
      columns: { ...NO_ROUTE, routedSuggestionId: s.id },
      keys: [s.id],
      facts: {
        suggestion: { kind: s.kind, requirementId: s.requirementId },
        routedRequirement: null,
      },
    };
  }
  if (route === 'new_requirement' && w.requirement) {
    const req = await requirementRefIn(projectId, w.requirement, '/requirement');
    if (isRefusal(req)) return { refusal: req };
    return {
      ...none,
      columns: { ...NO_ROUTE, routedRequirementId: req.id },
      keys: [req.key],
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
      keys: [feedbackKey(root.fbSeq)],
    };
  }
  return none;
}

/**
 * The upgrade issue waits on the contract version the change names (contract >= version), never on
 * the provider's issue (E1), due by the end of the provider's commitment window (E3), written as
 * data on the wait. Written in the triage's own transaction, so it is never dispatched first; a
 * filed issue and every existing one the route names carry it alike.
 */
async function upgradeWaitIn(
  tx: Tx,
  row: RouteInput['row'],
  issue: CarrierIssue,
  userId: string,
): Promise<Refusal | null> {
  const { contractProviderProjectId, contractSlug, contractVersion } = row;
  if (!contractProviderProjectId || !contractSlug || !contractVersion) {
    throw new Error(
      `${feedbackKey(row.fbSeq)} is a contract change naming no provider contract version, so its upgrade issue has nothing to wait on`,
    );
  }
  const refusal = upgradeTargetRefusal(
    issue,
    await liveWaitOn(tx, {
      issueId: issue.id,
      providerProjectId: contractProviderProjectId,
      contractSlug,
    }),
    issue.path,
  );
  if (refusal) return refusal;
  await insertContractWaitIn(tx, {
    projectId: row.projectId,
    issueId: issue.id,
    providerProjectId: contractProviderProjectId,
    contractSlug,
    minVersion: contractVersion,
    reason: `Upgrade carried by ${feedbackKey(row.fbSeq)}`,
    createdBy: userId,
    dueAt: row.dueAt,
  });
  return null;
}

type CreateIssue = NonNullable<FeedbackTriage['createIssue']>;

/** The filed issue's bands: what the triager named, else priority from severity and category from kind. */
export function carrierBands(
  row: { severity: Row['severity']; kind: Row['kind'] },
  named: CreateIssue | undefined,
): {
  priority: NonNullable<CreateIssue['priority']>;
  category: string;
  complexity: CreateIssue['complexity'] | null;
} {
  return {
    priority: named?.priority ?? row.severity,
    category: named?.category ?? (row.kind === 'bug' ? 'bug' : 'feature'),
    complexity: named?.complexity ?? null,
  };
}

/** A bug's issue, or a contract change's upgrade issue due by the provider's commitment window. */
async function fileIssueIn(tx: Tx, input: RouteInput): Promise<CarrierIssue> {
  const { row, write: w, target, actor } = input;
  const key = feedbackKey(row.fbSeq);
  // an issue is product content every agent reads: at no_egress it carries the reference alone
  const copied = egressAt(
    await dataPolicyOf(row.projectId),
    'feedback',
    { title: row.title, body: row.body ?? '' },
    key,
  );
  const carried = copied.ok
    ? [`Carries ${key}: ${copied.value.title}`, copied.value.body]
    : [
        `Carries ${key}. Its content stays in Forge under this project's no_egress policy; read it on the Feedback page.`,
      ];
  const linkable =
    target && !linkIssueRefusal(target.status as Parameters<typeof linkIssueRefusal>[0]);
  const issue = await insertIssueRow(
    tx,
    {
      projectId: row.projectId,
      title: w.createIssue?.title ?? (copied.ok ? copied.value.title : `Feedback ${key}`),
      description: w.createIssue?.description ?? carried.filter(Boolean).join('\n\n'),
      descriptionFormat: 'markdown',
      status: 'draft',
      ...carrierBands(row, w.createIssue),
      createdById: actor.userId,
      createdByDeviceId: null,
      createdVia: input.channel,
      requirementId: linkable ? target.id : null,
      fromSuggestionId: input.fromSuggestionId,
    },
    { actor: { type: 'user', id: actor.userId, agency: actor.agency } },
  );
  const filed = {
    id: issue.id,
    key: formatIssueRef(await activeIssuePrefix(row.projectId), issue.issSeq),
    status: issue.status,
  };
  if (row.kind === 'contract_change') {
    const refusal = await upgradeWaitIn(tx, row, filed, actor.userId);
    if (refusal) throw new Error(`a filed upgrade issue was refused its wait: ${refusal.detail}`);
  }
  return filed;
}

async function writeRouteIn(
  tx: Tx,
  input: RouteInput,
): Promise<{ refusals: Refusal[] } | { carriers: string[] }> {
  const { row, route, write: w, actor } = input;
  const named = await namedCarrierIn(tx, input);
  if ('refusal' in named) return { refusals: [named.refusal] };
  const fit = routeRuleRefusal(route, {
    kind: row.kind,
    targetRequirement: input.target,
    ...named.facts,
  });
  if (fit) return { refusals: [fit] };
  let { columns, keys, issues } = named;
  const filed = route === 'issue' && w.createIssue !== undefined;
  if (filed) {
    issues = [await fileIssueIn(tx, input)];
    keys = issues.map((i) => i.key);
  } else if (route === 'issue' && row.kind === 'contract_change') {
    for (const issue of issues) {
      const refusal = await upgradeWaitIn(tx, row, issue, actor.userId);
      if (refusal) return { refusals: [refusal] };
    }
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
    keys = [requirementKey(req.reqSeq)];
  }
  await tx
    .update(feedback)
    .set({ route, ...columns, updatedAt: new Date() })
    .where(eq(feedback.id, row.id));
  if (issues.length) {
    await tx
      .insert(feedbackRouteIssues)
      .values(issues.map((i) => ({ feedbackId: row.id, issueId: i.id })));
  }
  for (const issue of issues) {
    await writeRecordEvent(
      {
        issueId: issue.id,
        actor: { type: 'user', id: actor.userId, agency: actor.agency },
        kind: 'decision',
        contract: 1,
        fields: [
          { key: 'lead', value: `${feedbackKey(row.fbSeq)} routed to this issue` },
          { key: 'feedback', value: feedbackKey(row.fbSeq) },
          { key: 'outcome', value: filed ? 'filed' : 'linked' },
        ],
      },
      tx,
    );
  }
  return { carriers: keys };
}
