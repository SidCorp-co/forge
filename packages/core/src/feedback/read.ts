/**
 * The reads of feedback: the list the Feedback page opens with its derived facts (phase, who it
 * waits on, the carrier's own status), the detail, and the helpers every write resolves an item, a
 * target or a carrier with. Phases come from `rules.ts:phaseOf`; nothing here stores one.
 */

import type {
  FeedbackAttention,
  FeedbackDecisionView,
  FeedbackListResponse,
  FeedbackPhase,
  FeedbackRouteView,
  FeedbackSummary,
  FeedbackTargetView,
  FeedbackView,
} from '@forge/contracts/feedback';
import type { SuggestionStatus } from '@forge/contracts/suggestions';
import type { NodeRef } from '@forge/contracts/workflow-health';
import { and, asc, count, desc, eq, ilike, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { issues, pipelineRuns, projects } from '../db/schema.js';
import { feedback, feedbackAttachments, feedbackDecisions } from '../db/schema-feedback.js';
import { agentQuestions } from '../db/schema-questions.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { isUuid } from '../issues/issue-route-ref.js';
import { assertProjectAccess, effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { actMiss, PERSON_ACT, PERSON_ADMIN_ACT } from '../lib/person-act.js';
import { requirementKey } from '../requirements/read.js';
import { deliveredAmong } from '../requirements/standing-read.js';
import { userNames } from '../workflows/service.js';
import { feedbackEgress, type ReadDoor, WITHHELD } from './egress.js';
import { targetTypeOf } from './refs.js';
import { feedbackIdsOfRequirement, NO_FEEDBACK, sourceOf } from './relations.js';
import {
  attentionOf,
  type FeedbackRefusal,
  type PhaseFacts,
  phaseOf,
  searchWithheldRefusal,
  waitingFor,
  waitingOf,
  waitingOnOf,
} from './rules.js';

export interface FeedbackActor {
  userId: string;
  agency: ActorAgency;
}

export type Row = typeof feedback.$inferSelect;

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

export const feedbackKey = (seq: number) => `FB-${seq}`;

/** An item of `projectId` by uuid, `FB-n` or `n`, locked for update when asked; 404 otherwise. */
export async function rowIn(tx: Tx, projectId: string, ref: string, lock = false): Promise<Row> {
  const seq = /^(?:FB-)?(\d{1,9})$/i.exec(ref.trim())?.[1];
  const uuid = isUuid(ref) ? ref : null;
  if (!seq && !uuid) throw notFound(`"${ref}" is neither a feedback uuid nor a key like FB-12`);
  const query = tx
    .select()
    .from(feedback)
    .where(
      and(
        eq(feedback.projectId, projectId),
        seq ? eq(feedback.fbSeq, Number(seq)) : eq(feedback.id, uuid as string),
      ),
    );
  const [row] = lock ? await query.for('update') : await query;
  if (!row) throw notFound(`project ${projectId} holds no feedback ${ref}`);
  return row;
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
}

const ids = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];

export async function linkedOf(projectId: string, rows: Row[]): Promise<Linked> {
  const issueIds = ids(rows.flatMap((r) => [r.issueId, r.routedIssueId]));
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
              requirementId: requirementRevisions.requirementId,
            })
            .from(suggestions)
            .leftJoin(
              requirementRevisions,
              eq(requirementRevisions.fromSuggestionId, suggestions.id),
            )
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
    names: await userNames(allRows.map((r) => r.reportedBy)),
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

function targetView(r: Row, l: Linked): FeedbackTargetView {
  const type = targetTypeOf(r);
  if (type === 'requirement') {
    const q = l.requirements.get(r.requirementId as string);
    return { type, key: q?.key ?? (r.requirementId as string), title: q?.title ?? null };
  }
  if (type === 'issue') {
    const i = l.issues.get(r.issueId as string);
    return { type, key: i?.key ?? (r.issueId as string), title: i?.title ?? null };
  }
  if (type === 'release') {
    return {
      type,
      key: l.releases.get(r.releaseRunId as string) ?? (r.releaseRunId as string),
      title: null,
    };
  }
  if (type === 'workflow') {
    const w = l.workflows.get(r.workflowId as string);
    const node: NodeRef | null = r.stepId
      ? { step: r.stepId }
      : r.edgeFrom && r.edgeTo
        ? {
            edge: {
              from: r.edgeFrom,
              to: r.edgeTo,
              ...(r.edgeLabel ? { label: r.edgeLabel } : {}),
            },
          }
        : null;
    return {
      type,
      key: w?.flow ?? (r.workflowId as string),
      title: w?.title ?? null,
      ...(node ? { node } : {}),
    };
  }
  if (type === 'contract') {
    const provider = l.providers.get(r.contractProviderProjectId as string);
    return { type, key: `${provider}/${r.contractSlug}@${r.contractVersion}`, title: null };
  }
  return { type, key: r.whereSeen ?? '', title: null };
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
  const attention = attentionOf(phase, viewer.userId === r.reportedBy);
  const waiting = waitingOf(phase, r.route, route?.key ?? null, reporterName ?? 'The reporter');
  return {
    id: r.id,
    key: feedbackKey(r.fbSeq),
    title: withhold ? `${feedbackKey(r.fbSeq)} (${WITHHELD})` : r.title,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    phase,
    attention,
    waitingOn: waitingOnOf(phase, r.route, route?.key ?? null, reporterName ?? 'The reporter'),
    waiting: waitingFor(waiting, attention),
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
  await assertProjectAccess(projectId, viewer.userId, 'viewer');
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
  const counts = { you: 0, moving: 0, others: 0, done: 0 } as Record<FeedbackAttention, number>;
  for (const s of all) counts[s.attention] += 1;
  return { ok: true, list: { feedback: listed, counts, sensitive: level !== 'off' } };
}

/** The phase of one item as a write reads it, under the write's own transaction where given. */
export async function phaseOfRow(projectId: string, row: Row): Promise<FeedbackPhase> {
  return phaseIn(row, await linkedOf(projectId, [row]));
}

export async function detailAs(
  viewer: FeedbackActor,
  projectId: string,
  ref: string,
  door: ReadDoor = {},
): Promise<FeedbackView> {
  await assertProjectAccess(projectId, viewer.userId, 'viewer');
  const row = await rowIn(db, projectId, ref);
  const [level, access, linked, decisions, attachments, questions, pointing, [open], source] =
    await Promise.all([
      dataPolicyOf(projectId),
      effectiveProjectRole(viewer.userId, projectId),
      linkedOf(projectId, [row]),
      db
        .select()
        .from(feedbackDecisions)
        .where(eq(feedbackDecisions.feedbackId, row.id))
        .orderBy(asc(feedbackDecisions.decidedAt)),
      db
        .select()
        .from(feedbackAttachments)
        .where(eq(feedbackAttachments.feedbackId, row.id))
        .orderBy(asc(feedbackAttachments.createdAt)),
      db
        .select({
          id: agentQuestions.id,
          status: agentQuestions.status,
          steps: agentQuestions.steps,
        })
        .from(agentQuestions)
        .where(eq(agentQuestions.feedbackId, row.id))
        .orderBy(desc(agentQuestions.createdAt))
        .limit(1),
      db
        .select({ seq: feedback.fbSeq })
        .from(feedback)
        .where(eq(feedback.duplicateOf, row.id))
        .orderBy(asc(feedback.fbSeq)),
      db
        .select({ n: count() })
        .from(suggestions)
        .where(and(eq(suggestions.feedbackId, row.id), eq(suggestions.status, 'proposed'))),
      sourceOf(row.id),
    ]);
  const { withhold, shown } = feedbackEgress(level, viewer.agency, door);
  const summary = summaryOf(row, linked, viewer, withhold);
  const deciders = await userNames(decisions.map((d) => d.decidedBy));
  const facts = { userId: viewer.userId, agency: viewer.agency, role: access?.role ?? null };
  const q = questions[0];
  const step = q?.steps.at(-1);
  const root = row.duplicateOf ? linked.roots.get(row.duplicateOf) : undefined;
  return shown<FeedbackView>(
    {
      ...summary,
      body: withhold ? null : row.body,
      whereSeen: withhold ? null : row.whereSeen,
      duplicateOf: root ? feedbackKey(root.fbSeq) : null,
      duplicates: pointing.map((p) => feedbackKey(p.seq)),
      source:
        source && withhold ? { agentReport: { ...source.agentReport, targetRef: null } } : source,
      decisions: decisions.map(
        (d): FeedbackDecisionView => ({
          decision: d.decision,
          route: d.route,
          carrier: d.carrier,
          reason: withhold ? null : d.reason,
          decidedBy: d.decidedBy,
          decidedByName: deciders.get(d.decidedBy) ?? null,
          decidedAgency: d.decidedAgency,
          decidedAt: d.decidedAt.toISOString(),
          fromSuggestionId: d.fromSuggestionId,
        }),
      ),
      attachments: attachments.map((a) => ({
        id: a.id,
        name: withhold ? 'withheld' : a.name,
        mime: a.mime,
        size: a.size,
        flagged: a.flagged,
        createdAt: a.createdAt.toISOString(),
      })),
      clarification: q
        ? {
            id: q.id,
            status: q.status,
            prompt: withhold ? null : (step?.prompt ?? null),
            answer: withhold
              ? null
              : step && 'answerText' in step
                ? (step.answerText ?? null)
                : null,
          }
        : null,
      openSuggestions: open?.n ?? 0,
      can: {
        triage:
          !actMiss(facts, PERSON_ACT) && ['new', 'triaged', 'reopened'].includes(summary.phase),
        verify: !actMiss(facts, PERSON_ACT) && summary.phase === 'resolved',
        redact: !actMiss(facts, PERSON_ADMIN_ACT) && row.redactedAt === null,
      },
      sensitive: level !== 'off',
    },
    feedbackKey(row.fbSeq),
  );
}
