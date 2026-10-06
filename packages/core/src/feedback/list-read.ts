/** The list's derived facts per item: phase, who it waits on, the carrier's own status. Phases come from `standing.ts:phaseOf`; nothing here stores one. */

import {
  FEEDBACK_ATTENTION_GROUPS,
  type FeedbackAttentionGroup,
  type FeedbackCarrierView,
  type FeedbackListResponse,
  type FeedbackPhase,
  type FeedbackRouteView,
  type FeedbackSummary,
  feedbackKey,
} from '@forge/contracts/feedback';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { releaseApprovalRequired } from '@forge/contracts/releases';
import { requirementKey } from '@forge/contracts/requirements';
import type { SuggestionStatus } from '@forge/contracts/suggestions';
import { and, asc, desc, eq, ilike, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projects } from '../db/schema.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { activeIssuePrefix } from '../issues/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { userNames } from '../lib/people.js';
import { actorFor, holds, projectResource, requireCan } from '../permissions/index.js';
import { productionOf, readProjectDocument } from '../project-config/index.js';
import { deliveredAmong } from '../requirements/index.js';
import { feedbackEgress, type ReadDoor, WITHHELD } from './egress.js';
import { liveMasterOwedTriages } from './owed-triage.js';
import type { FeedbackActor, Row } from './read.js';
import { feedbackIdsOfRequirement, NO_FEEDBACK } from './relations.js';
import { type FeedbackRefusal, searchWithheldRefusal } from './rules.js';
import {
  type CarrierRelease,
  feedbackStandingOf,
  type PhaseFacts,
  phaseOf,
  revisionStageOf,
  type StandingViewer,
} from './standing.js';
import { targetView } from './target-view.js';

/** Everything the rows point at, loaded once for a page of rows. */
export interface Linked {
  prefix: string | null;
  issues: Map<string, { key: string; title: string; status: string }>;
  /** The issues each issue-routed item names as its carriers, by item id, oldest issue first. */
  routeIssues: Map<string, string[]>;
  requirements: Map<string, { key: string; title: string; status: string; delivered: boolean }>;
  releases: Map<string, string>;
  workflows: Map<string, { flow: string; title: string | null }>;
  providers: Map<string, string>;
  suggestions: Map<
    string,
    {
      status: string;
      revisionLive: boolean;
      revisionState: string | null;
      delivered: boolean;
      requirement: string | null;
      revision: number | null;
    }
  >;
  roots: Map<string, Row>;
  names: Map<string, string>;
  /** Items of these rows the project's live master owes a triage; none where no master is live. */
  masterOwed: Set<string>;
  /** How this project's release is made, read only where a routed issue waits at the gate. */
  release: CarrierRelease | null;
}

/** The viewer's acts on this project's feedback, by the same checks a detail's `can` reads. */
export type ViewerCan = Omit<StandingViewer, 'isReporter'>;

type PermissionFacts = Parameters<typeof holds>[0];

export function viewerCanOf(facts: PermissionFacts): ViewerCan {
  return {
    canTriage: holds(facts, 'feedback.approve'),
    canApproveRelease: holds(facts, 'releases.approve'),
    canWrite: holds(facts, 'project.write'),
  };
}

export async function viewerCanIn(userId: string, projectId: string): Promise<ViewerCan> {
  const access = await effectiveProjectRole(userId, projectId);
  return viewerCanOf({ projectId, role: access?.role ?? null, grants: access?.grants ?? [] });
}

const AT_RELEASE_GATE = 'awaiting_release';

async function releaseOf(projectId: string): Promise<CarrierRelease> {
  const document = (await readProjectDocument(projectId))?.document;
  const production = document ? productionOf(document) : null;
  if (!production) return 'none';
  if (releaseApprovalRequired(document)) return 'approval';
  const deployment = production.declaration.deployment;
  return 'trigger' in deployment && deployment.trigger === 'on-land' ? 'automatic' : 'manual';
}

const ids = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];

/** Every issue an issue route names, per item, oldest issue first. */
async function routeIssuesOf(rows: Row[]): Promise<Map<string, string[]>> {
  const routed = rows.filter((r) => r.route === 'issue').map((r) => r.id);
  const out = new Map<string, string[]>();
  if (routed.length === 0) return out;
  const links = await db
    .select({ feedbackId: feedbackRouteIssues.feedbackId, issueId: feedbackRouteIssues.issueId })
    .from(feedbackRouteIssues)
    .innerJoin(issues, eq(issues.id, feedbackRouteIssues.issueId))
    .where(inArray(feedbackRouteIssues.feedbackId, routed))
    .orderBy(asc(issues.issSeq));
  for (const l of links) out.set(l.feedbackId, [...(out.get(l.feedbackId) ?? []), l.issueId]);
  return out;
}

export async function linkedOf(projectId: string, rows: Row[]): Promise<Linked> {
  const routeIssues = await routeIssuesOf(rows);
  const issueIds = ids([...rows.map((r) => r.issueId), ...[...routeIssues.values()].flat()]);
  const reqIds = ids(rows.flatMap((r) => [r.requirementId, r.routedRequirementId]));
  const releaseIds = ids(rows.map((r) => r.releaseRunId));
  const workflowIds = ids(rows.map((r) => r.workflowId));
  const suggestionIds = ids(rows.map((r) => r.routedSuggestionId));
  const known = new Set(rows.map((r) => r.id));
  const rootIds = ids(rows.map((r) => r.duplicateOf)).filter((id) => !known.has(id));
  const [prefix, issueRows, reqRows, releaseRows, workflowRows, suggestionRows, rootRows] =
    await Promise.all([
      activeIssuePrefix(projectId),
      issueIds.length
        ? db
            .select({
              id: issues.id,
              seq: issues.issSeq,
              title: issues.title,
              status: issues.status,
            })
            .from(issues)
            .where(inArray(issues.id, issueIds))
        : [],
      reqIds.length
        ? db
            .select({
              id: requirements.id,
              seq: requirements.reqSeq,
              title: requirements.title,
              status: requirements.status,
            })
            .from(requirements)
            .where(inArray(requirements.id, reqIds))
        : [],
      releaseIds.length
        ? db
            .select({ id: pipelineRuns.id, version: pipelineRuns.releaseVersion })
            .from(pipelineRuns)
            .where(inArray(pipelineRuns.id, releaseIds))
        : [],
      workflowIds.length
        ? db
            .select({
              id: projectWorkflows.id,
              flow: projectWorkflows.flow,
              document: projectWorkflows.document,
            })
            .from(projectWorkflows)
            .where(inArray(projectWorkflows.id, workflowIds))
        : [],
      suggestionIds.length
        ? db
            .select({
              id: suggestions.id,
              status: suggestions.status,
              revisionState: requirementRevisions.state,
              revision: requirementRevisions.revision,
              requirementId: requirementRevisions.requirementId,
              requirementSeq: requirements.reqSeq,
            })
            .from(suggestions)
            .leftJoin(
              requirementRevisions,
              eq(requirementRevisions.fromSuggestionId, suggestions.id),
            )
            .leftJoin(requirements, eq(requirements.id, requirementRevisions.requirementId))
            .where(inArray(suggestions.id, suggestionIds))
        : [],
      rootIds.length ? db.select().from(feedback).where(inArray(feedback.id, rootIds)) : [],
    ]);
  const allRows = [...rows, ...rootRows];
  const providerIds = ids(rows.map((r) => r.contractProviderProjectId));
  const providerRows = providerIds.length
    ? await db
        .select({ id: projects.id, slug: projects.slug })
        .from(projects)
        .where(inArray(projects.id, providerIds))
    : [];
  const delivered = await deliveredAmong(
    projectId,
    ids([...reqRows.map((r) => r.id), ...suggestionRows.map((s) => s.requirementId)]),
  );
  const carrying = new Set([...routeIssues.values()].flat());
  const atGate = issueRows.some((i) => i.status === AT_RELEASE_GATE && carrying.has(i.id));
  const [owed, release] = await Promise.all([
    rows.some((r) => r.status === 'new' || r.status === 'reopened')
      ? liveMasterOwedTriages(projectId)
      : [],
    atGate ? releaseOf(projectId) : null,
  ]);
  return {
    masterOwed: new Set(owed.map((o) => o.feedbackId)),
    release,
    prefix,
    providers: new Map(providerRows.map((p) => [p.id, p.slug])),
    issues: new Map(
      issueRows.map((i) => [
        i.id,
        { key: formatIssueRef(prefix, i.seq), title: i.title, status: i.status },
      ]),
    ),
    routeIssues,
    requirements: new Map(
      reqRows.map((r) => [
        r.id,
        {
          key: requirementKey(r.seq),
          title: r.title,
          status: r.status,
          delivered: delivered.has(r.id),
        },
      ]),
    ),
    releases: new Map(releaseRows.map((r) => [r.id, r.version ?? r.id])),
    workflows: new Map(
      workflowRows.map((w) => [
        w.id,
        {
          flow: w.flow,
          title: ((w.document as { title?: unknown }).title as string | undefined) ?? null,
        },
      ]),
    ),
    suggestions: new Map(
      suggestionRows.map((s) => [
        s.id,
        {
          status: s.status,
          revisionLive: s.revisionState === 'current' || s.revisionState === 'superseded',
          revisionState: s.revisionState,
          delivered: s.requirementId !== null && delivered.has(s.requirementId),
          requirement: s.requirementSeq === null ? null : requirementKey(s.requirementSeq),
          revision: s.revision,
        },
      ]),
    ),
    roots: new Map(allRows.map((r) => [r.id, r])),
    names: await userNames(allRows.map((r) => r.reportedBy)),
  };
}

/** Every issue an issue-routed item names, by key with its own status; none for another route. */
function routeIssueViews(r: Row, l: Linked): { key: string; status: string }[] {
  return (l.routeIssues.get(r.id) ?? []).map((id) => {
    const issue = l.issues.get(id);
    if (!issue) {
      throw new Error(
        `${feedbackKey(r.fbSeq)} is carried by issue ${id}, which the carriers' read did not load`,
      );
    }
    return { key: issue.key, status: issue.status };
  });
}

function phaseFacts(r: Row, l: Linked, rootPhase: FeedbackPhase | null): PhaseFacts {
  const s = r.routedSuggestionId ? l.suggestions.get(r.routedSuggestionId) : undefined;
  return {
    status: r.status,
    route: r.route,
    routedIssueStatuses: routeIssueViews(r, l).map((i) => i.status),
    suggestion: s
      ? {
          status: s.status as SuggestionStatus,
          revisionLive: s.revisionLive,
          delivered: s.delivered,
        }
      : null,
    routedRequirementStatus: r.routedRequirementId
      ? (l.requirements.get(r.routedRequirementId)?.status ?? null)
      : null,
    routedRequirementDelivered: r.routedRequirementId
      ? (l.requirements.get(r.routedRequirementId)?.delivered ?? false)
      : false,
    rootPhase,
  };
}

export function phaseIn(r: Row, l: Linked): FeedbackPhase {
  const root = r.duplicateOf ? l.roots.get(r.duplicateOf) : undefined;
  const rootPhase = root ? phaseOf(phaseFacts(root, l, null)) : null;
  return phaseOf(phaseFacts(r, l, rootPhase));
}

const one = (carrier: FeedbackCarrierView): FeedbackCarrierView[] => [carrier];

export function routeView(r: Row, l: Linked): FeedbackRouteView | null {
  if (!r.route) return null;
  switch (r.route) {
    case 'issue':
      return { route: r.route, carriers: routeIssueViews(r, l), answer: null };
    case 'new_requirement': {
      const q = l.requirements.get(r.routedRequirementId as string);
      const carriers = one({ key: q?.key ?? null, status: q?.status ?? null });
      return { route: r.route, carriers, answer: null };
    }
    case 'revision': {
      const s = l.suggestions.get(r.routedSuggestionId as string);
      const carriers = one({ key: r.routedSuggestionId, status: s?.status ?? null });
      return { route: r.route, carriers, answer: null };
    }
    case 'duplicate': {
      const root = l.roots.get(r.duplicateOf as string);
      const carriers = one({
        key: root ? feedbackKey(root.fbSeq) : null,
        status: root ? phaseIn(root, l) : null,
      });
      return { route: r.route, carriers, answer: null };
    }
    case 'answer':
      return { route: r.route, carriers: [], answer: r.answer };
  }
}

/** What a planned item still waits on: an issue route's carriers not yet closed or dropped, any other route's one carrier. */
function owedCarriers(route: FeedbackRouteView | null): FeedbackCarrierView[] {
  if (!route) return [];
  if (route.route !== 'issue') return route.carriers;
  const finished: readonly (string | null)[] = ISSUE_TERMINAL_STATUSES;
  return route.carriers.filter((c) => !finished.includes(c.status));
}

export function summaryOf(
  r: Row,
  l: Linked,
  viewer: FeedbackActor,
  withhold: boolean,
  can: ViewerCan,
): FeedbackSummary {
  const phase = phaseIn(r, l);
  const route = routeView(r, l);
  const reporterName = l.names.get(r.reportedBy) ?? null;
  const reporter = reporterName ?? 'The reporter';
  const owed = owedCarriers(route);
  const standing = feedbackStandingOf(
    phase,
    r.route,
    owed.flatMap((c) => (c.key ? [c.key] : [])),
    reporter,
    { ...can, isReporter: viewer.userId === r.reportedBy },
    r.route === 'revision' && r.routedSuggestionId
      ? revisionStageOf(l.suggestions.get(r.routedSuggestionId) ?? null)
      : null,
    {
      masterOwesTriage: l.masterOwed.has(r.id),
      carrierRelease:
        phase === 'planned' &&
        r.route === 'issue' &&
        owed.length > 0 &&
        owed.every((c) => c.status === AT_RELEASE_GATE)
          ? l.release
          : null,
    },
  );
  return {
    id: r.id,
    key: feedbackKey(r.fbSeq),
    title: withhold ? `${feedbackKey(r.fbSeq)} (${WITHHELD})` : r.title,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    phase,
    ...standing,
    target: targetView(r, l),
    route: withhold && route?.answer ? { ...route, answer: null } : route,
    reporter: { id: r.reportedBy, name: reporterName, agency: r.reporterAgency },
    dueAt: r.dueAt?.toISOString() ?? null,
    redacted: r.redactedAt !== null,
    redactedAt: r.redactedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listFeedbackAs(
  viewer: FeedbackActor,
  projectId: string,
  query: {
    phases?: readonly FeedbackPhase[] | undefined;
    q?: string | undefined;
    requirement?: string | undefined;
  } = {},
  door: ReadDoor = {},
): Promise<{ ok: true; list: FeedbackListResponse } | { ok: false; refusals: FeedbackRefusal[] }> {
  await requireCan(actorFor(viewer.userId), 'project.read', projectResource(projectId));
  const level = await dataPolicyOf(projectId);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  const searchRefused = searchWithheldRefusal(query.q, withhold);
  if (searchRefused) return { ok: false, refusals: [searchRefused] };
  const about = query.requirement
    ? await feedbackIdsOfRequirement(projectId, query.requirement)
    : null;
  const rows = await db
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, projectId),
        query.q ? ilike(feedback.title, `%${query.q}%`) : undefined,
        about ? inArray(feedback.id, about.length ? about : [NO_FEEDBACK]) : undefined,
      ),
    )
    .orderBy(desc(feedback.createdAt))
    .limit(500);
  const [linked, can] = await Promise.all([
    linkedOf(projectId, rows),
    viewerCanIn(viewer.userId, projectId),
  ]);
  const all = shown(
    rows.map((r) => summaryOf(r, linked, viewer, withhold, can)),
    'the feedback list',
  );
  const listed = query.phases?.length ? all.filter((s) => query.phases?.includes(s.phase)) : all;
  const counts = Object.fromEntries(FEEDBACK_ATTENTION_GROUPS.map((g) => [g, 0])) as Record<
    FeedbackAttentionGroup,
    number
  >;
  for (const s of all) counts[s.attentionGroup] += 1;
  return { ok: true, list: { feedback: listed, counts, sensitive: level !== 'off' } };
}

/** The phase of one item as a write reads it, under the write's own transaction where given. */
export async function phaseOfRow(projectId: string, row: Row): Promise<FeedbackPhase> {
  return phaseIn(row, await linkedOf(projectId, [row]));
}
