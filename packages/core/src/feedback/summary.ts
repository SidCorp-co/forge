/** The list's derived facts per item: phase, who it waits on, the carrier's own status. Phases come from `standing.ts:phaseOf`; nothing here stores one. */

import {
  FEEDBACK_ATTENTION_GROUPS,
  type FeedbackAttentionGroup,
  type FeedbackCaseView,
  type FeedbackListResponse,
  type FeedbackPhase,
  type FeedbackRouteView,
  type FeedbackSummary,
  feedbackKey,
} from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import type { SuggestionStatus } from '@forge/contracts/suggestions';
import { and, desc, eq, ilike, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projects } from '../db/schema.js';
import { feedback, feedbackCases } from '../db/schema-feedback.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { activeIssuePrefix } from '../issues/index.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { userNames } from '../lib/people.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { deliveredAmong } from '../requirements/index.js';
import { feedbackEgress, type ReadDoor, WITHHELD } from './egress.js';
import type { CaseRow, FeedbackActor, Row } from './read.js';
import { feedbackIdsOfRequirement, NO_FEEDBACK } from './relations.js';
import { type FeedbackRefusal, searchWithheldRefusal } from './rules.js';
import { feedbackStandingOf, type PhaseFacts, phaseOf } from './standing.js';
import { targetView } from './target-view.js';

async function casesOf(feedbackIds: readonly string[]): Promise<Map<string, CaseRow>> {
  if (feedbackIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(feedbackCases)
    .where(inArray(feedbackCases.feedbackId, [...feedbackIds]));
  return new Map(rows.map((r) => [r.feedbackId, r]));
}

function caseView(c: CaseRow, now: Date = new Date()): FeedbackCaseView {
  return {
    route: c.route,
    owner: c.owner,
    openedAt: c.openedAt.toISOString(),
    dueAt: c.dueAt.toISOString(),
    routedAt: c.routedAt?.toISOString() ?? null,
    overdue: c.routedAt === null && now.getTime() > c.dueAt.getTime(),
  };
}

/** Everything the rows point at, loaded once for a page of rows. */
export interface Linked {
  prefix: string | null;
  issues: Map<string, { key: string; title: string; status: string }>;
  requirements: Map<string, { key: string; title: string; status: string; delivered: boolean }>;
  releases: Map<string, string>;
  workflows: Map<string, { flow: string; title: string | null }>;
  providers: Map<string, string>;
  suggestions: Map<string, { status: string; revisionLive: boolean; delivered: boolean }>;
  roots: Map<string, Row>;
  names: Map<string, string>;
  cases: Map<string, CaseRow>;
}

const ids = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];

const issueHeads = (ids: string[]) =>
  ids.length
    ? db
        .select({ id: issues.id, seq: issues.issSeq, title: issues.title, status: issues.status })
        .from(issues)
        .where(inArray(issues.id, ids))
    : [];

const requirementHeads = (ids: string[]) =>
  ids.length
    ? db
        .select({
          id: requirements.id,
          seq: requirements.reqSeq,
          title: requirements.title,
          status: requirements.status,
        })
        .from(requirements)
        .where(inArray(requirements.id, ids))
    : [];

const suggestionHeads = (ids: string[]) =>
  ids.length
    ? db
        .select({
          id: suggestions.id,
          status: suggestions.status,
          revisionState: requirementRevisions.state,
          requirementId: requirementRevisions.requirementId,
        })
        .from(suggestions)
        .leftJoin(requirementRevisions, eq(requirementRevisions.fromSuggestionId, suggestions.id))
        .where(inArray(suggestions.id, ids))
    : [];

async function linkedRowsOf(projectId: string, rows: Row[]) {
  const known = new Set(rows.map((r) => r.id));
  const releaseIds = ids(rows.map((r) => r.releaseRunId));
  const workflowIds = ids(rows.map((r) => r.workflowId));
  const rootIds = ids(rows.map((r) => r.duplicateOf)).filter((id) => !known.has(id));
  const providerIds = ids(rows.map((r) => r.contractProviderProjectId));
  const [
    prefix,
    issueRows,
    reqRows,
    releaseRows,
    workflowRows,
    suggestionRows,
    rootRows,
    providerRows,
    cases,
  ] = await Promise.all([
    activeIssuePrefix(projectId),
    issueHeads(ids(rows.flatMap((r) => [r.issueId, r.routedIssueId]))),
    requirementHeads(ids(rows.flatMap((r) => [r.requirementId, r.routedRequirementId]))),
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
    suggestionHeads(ids(rows.map((r) => r.routedSuggestionId))),
    rootIds.length ? db.select().from(feedback).where(inArray(feedback.id, rootIds)) : [],
    providerIds.length
      ? db
          .select({ id: projects.id, slug: projects.slug })
          .from(projects)
          .where(inArray(projects.id, providerIds))
      : [],
    casesOf(rows.map((r) => r.id)),
  ]);
  return {
    prefix,
    issueRows,
    reqRows,
    releaseRows,
    workflowRows,
    suggestionRows,
    rootRows,
    providerRows,
    cases,
  };
}

export async function linkedOf(projectId: string, rows: Row[]): Promise<Linked> {
  const {
    prefix,
    issueRows,
    reqRows,
    releaseRows,
    workflowRows,
    suggestionRows,
    rootRows,
    providerRows,
    cases,
  } = await linkedRowsOf(projectId, rows);
  const allRows = [...rows, ...rootRows];
  const [delivered, names] = await Promise.all([
    deliveredAmong(
      projectId,
      ids([...reqRows.map((r) => r.id), ...suggestionRows.map((s) => s.requirementId)]),
    ),
    userNames(allRows.map((r) => r.reportedBy)),
  ]);
  return {
    prefix,
    providers: new Map(providerRows.map((p) => [p.id, p.slug])),
    issues: new Map(
      issueRows.map((i) => [
        i.id,
        { key: formatIssueRef(prefix, i.seq), title: i.title, status: i.status },
      ]),
    ),
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
          delivered: s.requirementId !== null && delivered.has(s.requirementId),
        },
      ]),
    ),
    roots: new Map(allRows.map((r) => [r.id, r])),
    names,
    cases,
  };
}

function phaseFacts(r: Row, l: Linked, rootPhase: FeedbackPhase | null): PhaseFacts {
  const s = r.routedSuggestionId ? l.suggestions.get(r.routedSuggestionId) : undefined;
  return {
    status: r.status,
    route: r.route,
    routedIssueStatus: r.routedIssueId ? (l.issues.get(r.routedIssueId)?.status ?? null) : null,
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

export function routeView(r: Row, l: Linked): FeedbackRouteView | null {
  if (!r.route) return null;
  switch (r.route) {
    case 'issue': {
      const i = l.issues.get(r.routedIssueId as string);
      return { route: r.route, key: i?.key ?? null, status: i?.status ?? null, answer: null };
    }
    case 'new_requirement': {
      const q = l.requirements.get(r.routedRequirementId as string);
      return { route: r.route, key: q?.key ?? null, status: q?.status ?? null, answer: null };
    }
    case 'revision': {
      const s = l.suggestions.get(r.routedSuggestionId as string);
      return { route: r.route, key: r.routedSuggestionId, status: s?.status ?? null, answer: null };
    }
    case 'duplicate': {
      const root = l.roots.get(r.duplicateOf as string);
      return {
        route: r.route,
        key: root ? feedbackKey(root.fbSeq) : null,
        status: root ? phaseIn(root, l) : null,
        answer: null,
      };
    }
    case 'answer':
      return { route: r.route, key: null, status: null, answer: r.answer };
  }
}

export function summaryOf(
  r: Row,
  l: Linked,
  viewer: FeedbackActor,
  withhold: boolean,
): FeedbackSummary {
  const phase = phaseIn(r, l);
  const route = routeView(r, l);
  const reporterName = l.names.get(r.reportedBy) ?? null;
  const stored = l.cases.get(r.id);
  const kase = stored ? caseView(stored) : null;
  const reporter = reporterName ?? 'The reporter';
  const standing = feedbackStandingOf(
    phase,
    r.route,
    route?.key ?? null,
    reporter,
    kase,
    viewer.userId === r.reportedBy,
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
    case: kase,
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
  const linked = await linkedOf(projectId, rows);
  const all = shown(
    rows.map((r) => summaryOf(r, linked, viewer, withhold)),
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
