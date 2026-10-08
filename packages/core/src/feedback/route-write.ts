/**
 * The route write (workflow requirement-to-delivery step `route`): a named carrier is resolved and
 * checked against the target, a carrier the triage asks for is filed, and the route columns and the
 * issue route's carriers (`feedback_route_issues`, ISS-265) are written in the triage's transaction.
 */

import {
  type FeedbackTriage,
  type FeedbackTriageRoute,
  feedbackKey,
} from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
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
import { type RouteFacts, routeRuleRefusal, upgradeTargetRefusal } from './rules.js';
import type { FeedbackChannel } from './service.js';
import { duplicateRefusal } from './verb-rules.js';

export type CarriedRoute = Exclude<FeedbackTriageRoute, 'decline'>;

type RouteColumns = Pick<
  typeof feedback.$inferInsert,
  'routedRequirementId' | 'routedSuggestionId' | 'duplicateOf' | 'answer'
>;

export const NO_ROUTE: RouteColumns = {
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

export interface RouteInput {
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
        status: root.status,
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
      // a title carried over from the item keeps the item's language; one the router wrote is theirs
      ...(w.createIssue?.title === undefined && copied.ok ? { writtenLang: row.writtenLang } : {}),
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

export async function writeRouteIn(
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
