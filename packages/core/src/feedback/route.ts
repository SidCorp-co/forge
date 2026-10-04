/** The route write (step `route`): a named carrier is resolved, the rule table checked against it, a carrier triage asks for is filed, and the route columns set. */

import {
  type FeedbackRouteWrite,
  type FeedbackTriageRoute,
  feedbackKey,
} from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { suggestions } from '../db/schema-suggestions.js';
import { activeIssuePrefix, insertIssueRow, writeRecordEvent } from '../issues/index.js';
import { dataPolicyOf, egressAt, storedText } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import type { Refusal } from '../lib/refusal.js';
import {
  createRequirementIn,
  linkIssueRefusal,
  lockRequirements,
  rowIn as requirementRowIn,
} from '../requirements/index.js';
import {
  duplicateKeysOf,
  type FeedbackActor,
  type Row,
  rowIn,
  type TargetRequirement,
} from './read.js';
import { isRefusal, issueRefIn, requirementRefIn } from './refs.js';
import { duplicateRefusal, type RouteFacts, routeRuleRefusal } from './rules.js';
import type { FeedbackChannel } from './service.js';

export type CarriedRoute = Exclude<FeedbackTriageRoute, 'decline'>;

type RouteColumns = Pick<
  typeof feedback.$inferInsert,
  'routedIssueId' | 'routedRequirementId' | 'routedSuggestionId' | 'duplicateOf' | 'answer'
>;

export const NO_ROUTE: RouteColumns = {
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

export interface RouteInput {
  row: Row;
  route: CarriedRoute;
  write: FeedbackRouteWrite;
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

/** An existing carrier the write names, resolved inside the item's project. */
async function namedCarrierIn(tx: Tx, input: RouteInput): Promise<{ refusal: Refusal } | Carrier> {
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
      columns: { ...NO_ROUTE, routedSuggestionId: s.id },
      key: s.id,
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
  // an issue is product content every agent reads: at no_egress it carries the reference alone
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
  const issue = await insertIssueRow(
    tx,
    {
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
    },
    { actor: { type: 'user', id: actor.userId, agency: actor.agency } },
  );
  return {
    id: issue.id,
    key: formatIssueRef(await activeIssuePrefix(row.projectId), issue.issSeq),
  };
}

export async function writeRouteIn(
  tx: Tx,
  input: RouteInput,
): Promise<{ refusals: Refusal[] } | { carrier: string | null }> {
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
  const filed = route === 'issue' && w.createIssue !== undefined;
  if (filed) {
    const issue = await fileIssueIn(tx, input);
    columns = { ...NO_ROUTE, routedIssueId: issue.id };
    key = issue.key;
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
          { key: 'outcome', value: filed ? 'filed' : 'linked' },
        ],
      },
      tx,
    );
  }
  return { carrier: key };
}
