/** The list's derived facts per item: phase, who it waits on, the carrier's own status. Phases come from `standing.ts:phaseOf`; nothing here stores one. */

import {
  FEEDBACK_VERIFY_WINDOW,
  type FeedbackCarrierView,
  type FeedbackOriginView,
  type FeedbackPhase,
  type FeedbackRouteView,
  type FeedbackSummary,
  feedbackKey,
} from '@forge/contracts/feedback';
import { RELEASE_ACT_PERMISSION } from '@forge/contracts/forecast';
import { ISSUE_TERMINAL_STATUSES } from '@forge/contracts/issue-machine';
import { requirementKey } from '@forge/contracts/requirements';
import type { SuggestionStatus } from '@forge/contracts/suggestions';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, pipelineRuns, projects } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';
import { suggestions } from '../db/schema-suggestions.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import { activeIssuePrefix } from '../issues/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { userNames } from '../lib/people.js';
import { holderNames, holds } from '../permissions/index.js';
import { readReleaseMode } from '../project-config/index.js';
import { deliveredAmong, nodesOfDesign } from '../requirements/index.js';
import { feedbackDependents } from './dependents.js';
import { WITHHELD } from './egress.js';
import { forgeOriginsOf } from './forge-reads.js';
import { carriersOf, type StandingFacts, standingFactsOf } from './list-standing.js';
import { liveMasterOwedTriages } from './owed-triage.js';
import type { FeedbackActor, Row } from './read.js';
import { routeIssuesOf } from './relations.js';
import { NONE_UNTOLD, notToldOf, type UntoldAmong, untoldAmong } from './ship-notice.js';
import {
  type CarrierRelease,
  feedbackStandingOf,
  type PhaseFacts,
  phaseOf,
  revisionStageOf,
  type StandingViewer,
} from './standing.js';
import { targetView } from './target-view.js';
import { recordCheckOf, verifyHeldOf, verifyWindowDays } from './verify-window.js';

/** Everything the rows point at, loaded once for a page of rows. */
export interface Linked extends StandingFacts {
  prefix: string | null;
  issues: Map<
    string,
    { key: string; title: string; status: string; releaseVersion: string | null }
  >;
  /** The issues each issue-routed item names as its carriers, by item id, oldest issue first. */
  routeIssues: Map<string, string[]>;
  requirements: Map<string, { key: string; title: string; status: string; delivered: boolean }>;
  releases: Map<string, string>;
  /** Each workflow's flow, title, and the words its design gives each step, by step id. */
  workflows: Map<
    string,
    { flow: string; title: string | null; steps: ReadonlyMap<string, string | null> }
  >;
  providers: Map<string, string>;
  /** Each mockup an item is about: its MK-n and its name (REQ-49 BC-4). */
  mockups?: Map<string, { key: string; name: string }>;
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
  /** Who holds the permission that release's person act takes, by name; empty where none is owed. */
  releaseHolders: string[];
  /** The project's verify window in days, read only where a triaged item could read resolved. */
  verifyWindowDays: number;
  /** Whose reporter nothing told among these rows (`ship-notice.ts:untoldAmong`). */
  untold: UntoldAmong;
  /** Where each row reported through the Forge door came from (`forge-reads.ts:forgeOriginsOf`). */
  origins: Map<string, FeedbackOriginView>;
}

/** The viewer's acts on this project's feedback, by the same checks a detail's `can` reads. */
export type ViewerCan = Omit<StandingViewer, 'isReporter'>;

type PermissionFacts = Parameters<typeof holds>[0];

export function viewerCanOf(facts: PermissionFacts): ViewerCan {
  return {
    canTriage: holds(facts, 'feedback.approve'),
    canApproveRelease: holds(facts, 'releases.approve'),
    canWrite: holds(facts, 'project.write'),
    canAdmin: holds(facts, 'project.admin'),
  };
}

export async function viewerCanIn(userId: string, projectId: string): Promise<ViewerCan> {
  const access = await effectiveProjectRole(userId, projectId);
  return viewerCanOf({ projectId, role: access?.role ?? null, grants: access?.grants ?? [] });
}

const AT_RELEASE_GATE = 'awaiting_release';

const ids = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => !!v))];

/** The MK-n and name of each mockup the rows are about, read through the mockups module's port. */
const mockupsOf = (rows: Row[]) =>
  feedbackDependents().mockupKeysOf(ids(rows.map((r) => r.mockupId)));

/** Each workflow a row targets: its flow, title, and the words its design gives each step. */
const workflowsOf = (rows: readonly { id: string; flow: string; document: unknown }[]) =>
  new Map(
    rows.map((w) => [
      w.id,
      {
        flow: w.flow,
        title: ((w.document as { title?: unknown }).title as string | undefined) ?? null,
        steps: nodesOfDesign(w.document)?.steps ?? new Map<string, string | null>(),
      },
    ]),
  );

/**
 * The originals `rows` name that are not among them. A duplicate's phase is its original's, so their
 * own links are read too, or a duplicate of a shipped item reads planned (FB-188 on dev, 2026-10-23).
 */
async function rootsOf(rows: Row[]): Promise<Row[]> {
  const known = new Set(rows.map((r) => r.id));
  const rootIds = ids(rows.map((r) => r.duplicateOf)).filter((id) => !known.has(id));
  return rootIds.length ? db.select().from(feedback).where(inArray(feedback.id, rootIds)) : [];
}

export async function linkedOf(projectId: string, rows: Row[]): Promise<Linked> {
  const allRows = [...rows, ...(await rootsOf(rows))];
  const routeIssues = await routeIssuesOf(allRows);
  const issueIds = ids([...rows.map((r) => r.issueId), ...[...routeIssues.values()].flat()]);
  const reqIds = ids([
    ...rows.map((r) => r.requirementId),
    ...allRows.map((r) => r.routedRequirementId),
  ]);
  const releaseIds = ids(rows.map((r) => r.releaseRunId));
  const workflowIds = ids(rows.map((r) => r.workflowId));
  const suggestionIds = ids(allRows.map((r) => r.routedSuggestionId));
  const [prefix, issueRows, reqRows, releaseRows, workflowRows, suggestionRows] = await Promise.all(
    [
      activeIssuePrefix(projectId),
      issueIds.length
        ? db
            .select({
              id: issues.id,
              seq: issues.issSeq,
              title: issues.title,
              status: issues.status,
              releaseVersion: pipelineRuns.releaseVersion,
            })
            .from(issues)
            .leftJoin(pipelineRuns, eq(pipelineRuns.id, issues.releaseBatchRunId))
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
    ],
  );
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
  // an original read only as a root has its own standing read too: its duplicate reads it
  const carrying = new Set([...routeIssues.values()].flat());
  const atGate = issueRows.some((i) => i.status === AT_RELEASE_GATE && carrying.has(i.id));
  const [owed, release, windowDays, origins, standing] = await Promise.all([
    allRows.some((r) => r.status === 'new' || r.status === 'reopened')
      ? liveMasterOwedTriages(projectId)
      : [],
    atGate ? readReleaseMode(projectId) : null,
    allRows.some((r) => r.status === 'triaged') ? verifyWindowDays(projectId) : 0,
    forgeOriginsOf(rows.map((r) => r.id)),
    standingFactsOf(projectId, allRows, issueRows, carrying),
  ]);
  const releaseHolders =
    release && release !== 'automatic'
      ? await holderNames(RELEASE_ACT_PERMISSION[release], projectId)
      : [];
  const linked: Linked = {
    untold: NONE_UNTOLD,
    origins,
    ...standing,
    releaseHolders,
    verifyWindowDays: windowDays || FEEDBACK_VERIFY_WINDOW.defaultDays,
    masterOwed: new Set(owed.map((o) => o.feedbackId)),
    release,
    prefix,
    providers: new Map(providerRows.map((p) => [p.id, p.slug])),
    mockups: await mockupsOf(rows),
    issues: new Map(
      issueRows.map((i) => [
        i.id,
        {
          key: formatIssueRef(prefix, i.seq),
          title: i.title,
          status: i.status,
          releaseVersion: i.releaseVersion ?? null,
        },
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
    workflows: workflowsOf(workflowRows),
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
  const shipped = allRows.flatMap((r) => {
    const phase = r.route === 'issue' ? phaseIn(r, linked) : null;
    return phase === 'resolved' || phase === 'verified'
      ? [{ id: r.id, route: r.route, phase, reporterAgency: r.reporterAgency }]
      : [];
  });
  return { ...linked, untold: await untoldAmong(projectId, shipped) };
}

/** Every issue an issue-routed item names, by key with its own status; none for another route. */
function routeIssueViews(
  r: Row,
  l: Linked,
): (FeedbackCarrierView & { key: string; status: string })[] {
  return (l.routeIssues.get(r.id) ?? []).map((id) => {
    const issue = l.issues.get(id);
    if (!issue) {
      throw new Error(
        `${feedbackKey(r.fbSeq)} is carried by issue ${id}, which the carriers' read did not load`,
      );
    }
    return {
      key: issue.key,
      status: issue.status,
      ...(issue.releaseVersion ? { release: issue.releaseVersion } : {}),
    };
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

/** The snooze an item is still parked under: one that has run out reads as no snooze, so it is New again with nothing to clear. */
export function snoozeOf(
  r: Pick<Row, 'snoozedUntil' | 'snoozeReason'>,
  now: Date,
): { until: string; reason: string | null } | null {
  if (!r.snoozedUntil || r.snoozedUntil.getTime() <= now.getTime()) return null;
  return { until: r.snoozedUntil.toISOString(), reason: r.snoozeReason };
}

const SETTLED: readonly FeedbackPhase[] = ['resolved', 'verified', 'declined'];

/**
 * A duplicate of an unsettled original reads the original's own standing as no viewer, so the one
 * act stays on the original's row (K61, dev.299); a settled one asks its own reporter.
 */
function standingIn(r: Row, l: Linked, viewer: StandingViewer, now: Date) {
  const root = r.route === 'duplicate' && r.duplicateOf ? l.roots.get(r.duplicateOf) : undefined;
  if (!root || SETTLED.includes(phaseIn(root, l))) return ownStandingIn(r, l, viewer, now);
  const none = { canTriage: false, canApproveRelease: false, canWrite: false, canAdmin: false };
  return ownStandingIn(root, l, { ...none, isReporter: false }, now);
}

function ownStandingIn(r: Row, l: Linked, viewer: StandingViewer, now: Date) {
  const phase = phaseIn(r, l);
  const snoozed = snoozeOf(r, now);
  const route = routeView(r, l);
  const reporter = l.names.get(r.reportedBy) ?? 'The reporter';
  const owed = owedCarriers(route);
  const carried = r.route === 'issue' ? carriersOf(r, l) : { carrier: null, draft: null };
  return feedbackStandingOf(
    phase,
    r.route,
    owed.flatMap((c) => (c.key ? [c.key] : [])),
    reporter,
    viewer,
    r.route === 'revision' && r.routedSuggestionId
      ? revisionStageOf(l.suggestions.get(r.routedSuggestionId) ?? null)
      : null,
    {
      masterOwesTriage: l.masterOwed.has(r.id),
      snoozedUntil: snoozed?.until ?? null,
      recordCheckAt: recordCheckOf(r, phase, l.verifyWindowDays)?.toISOString() ?? null,
      recordCanSay: r.violatedCriterionId !== null,
      verifyHeld: verifyHeldOf(r, phase)?.why ?? null,
      carrierRelease:
        phase === 'planned' &&
        r.route === 'issue' &&
        owed.length > 0 &&
        owed.every((c) => c.status === AT_RELEASE_GATE)
          ? l.release
          : null,
      releaseHolders: l.releaseHolders,
      relayOwed: phase === 'resolved' && l.untold.untold.has(r.id),
      relayHolders: l.untold.relayHolders,
      reporterIsAgent: r.reporterAgency === 'agent',
      carrierVersion:
        owed.find((c) => c.release)?.release ??
        (phase === 'resolved' ? route?.carriers.find((c) => c.release)?.release : null) ??
        null,
      draftCarrier: carried.draft,
      carrier: carried.carrier,
    },
    { since: l.decidedAt.get(r.id) ?? r.createdAt, master: l.master, now },
  );
}

export function summaryOf(
  r: Row,
  l: Linked,
  viewer: FeedbackActor,
  withhold: boolean,
  can: ViewerCan,
  now: Date = new Date(),
): FeedbackSummary {
  const phase = phaseIn(r, l);
  const snoozed = snoozeOf(r, now);
  const route = routeView(r, l);
  const reporterName = l.names.get(r.reportedBy) ?? null;
  const standing = standingIn(r, l, { ...can, isReporter: viewer.userId === r.reportedBy }, now);
  return {
    reporterNotTold: notToldOf(r.id, l.untold),
    id: r.id,
    key: feedbackKey(r.fbSeq),
    title: withhold ? `${feedbackKey(r.fbSeq)} (${WITHHELD})` : r.title,
    writtenLang: withhold ? null : r.writtenLang,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    phase,
    ...standing,
    target: targetView(r, l),
    route: withhold && route?.answer ? { ...route, answer: null } : route,
    reporter: { id: r.reportedBy, name: reporterName, agency: r.reporterAgency },
    origin: l.origins.get(r.id) ?? null,
    dueAt: r.dueAt?.toISOString() ?? null,
    snoozed: withhold && snoozed ? { ...snoozed, reason: null } : snoozed,
    redacted: r.redactedAt !== null,
    redactedAt: r.redactedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The phase of one item as a write reads it, under the write's own transaction where given. */
export async function phaseOfRow(projectId: string, row: Row): Promise<FeedbackPhase> {
  return phaseIn(row, await linkedOf(projectId, [row]));
}
