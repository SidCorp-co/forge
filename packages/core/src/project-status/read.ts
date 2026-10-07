/**
 * How a project stands, in one read (JU-1, JU-3, JU-4, JU-10): assembled from the read models the
 * dashboard, Releases and Requirements already draw — the needs-you rows and the lists behind them
 * (`development`), and one forecast simulation (`forecast`) — so the status report, the assistant's
 * answer and the screens it summarises read the same numbers. It derives nothing those models do
 * not already decide: lateness is the forecast's, whom a row waits on is its own read model's.
 */

import type { DeliveryForecast, ForecastLate, ScopeForecast } from '@forge/contracts/forecast';
import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import {
  PROJECT_STATUS_ROWS,
  type ProjectStatus,
  type RoadmapItem,
  type StatusInFlight,
  type StatusLate,
  type StatusLateItem,
  type StatusNextRelease,
  type StatusRequirements,
  type StatusRoadmap,
  type StatusShipped,
  type StatusWait,
  type StatusWaits,
} from '@forge/contracts/project-status';
import type { ReleaseListResponse } from '@forge/contracts/releases';
import {
  REQUIREMENT_STATES,
  type RequirementState,
  type RequirementSummary,
} from '@forge/contracts/requirements';
import { needsViewer, type WaitingKind } from '@forge/contracts/standing';
import { type AttentionRow, type NeedsYouViewer, readAttention } from '../development/index.js';
import { readFeedbackForecasts, readForecastLine } from '../forecast/index.js';
import { peopleOf } from '../lib/people.js';
import { projectOrgHead } from '../projects/index.js';
import { deferralOf } from '../requirements/index.js';

const DAY_MS = 86_400_000;

/** The kinds whose turn is a person's: the viewer, a named person, or a role a person holds. */
const PERSON_KINDS: ReadonlySet<WaitingKind> = new Set(['you', 'person', 'admins', 'writers']);

/** Requirements on the delivery line: agreed and not yet accepted, or accepted. */
const LINE_STATES: ReadonlySet<RequirementState> = new Set([
  'agreed',
  'in_delivery',
  'delivered',
  'accepted',
]);

const byKey = (a: { key: string }, b: { key: string }) =>
  a.key.localeCompare(b.key, 'en', { numeric: true });

export type StatusViewer = NeedsYouViewer;

/** A promise's value and the moment it answered, so each section says when it was read. */
async function stamped<T>(p: Promise<T>): Promise<{ value: T; at: string }> {
  const value = await p;
  return { value, at: new Date().toISOString() };
}

function shippedOf(
  releases: ReleaseListResponse,
  scopes: readonly ScopeForecast[],
  since: Date,
  asOf: string,
): StatusShipped {
  const inWindow = releases.releases
    .filter((r) => r.state === 'shipped' && r.releasedAt !== null)
    .filter((r) => Date.parse(r.releasedAt as string) >= since.getTime())
    .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''));
  const requirementsShipped = scopes.flatMap((s) => {
    const at = s.delivery?.shipped?.at ?? null;
    return at && Date.parse(at) >= since.getTime() ? [{ key: s.key, title: s.title ?? s.key, at }] : [];
  });
  requirementsShipped.sort((a, b) => b.at.localeCompare(a.at));
  return {
    asOf,
    since: since.toISOString(),
    releases: inWindow.slice(0, PROJECT_STATUS_ROWS).map((r) => ({
      version: r.version,
      releasedAt: r.releasedAt as string,
      headline: r.headline,
      issueCount: r.issueCount,
      requirements: r.requirements,
      contents: r.contents,
      verified: r.verified,
    })),
    releaseCount: inWindow.length,
    issueCount: inWindow.reduce((n, r) => n + r.issueCount, 0),
    requirementsShipped,
  };
}

function inFlightOf(
  issues: Awaited<ReturnType<typeof readAttention>>['issues'],
  asOf: string,
): StatusInFlight {
  const tally = new Map<string, number>();
  for (const i of issues.issues) tally.set(i.status, (tally.get(i.status) ?? 0) + 1);
  const running = issues.issues.filter((i) => i.standing.inFlight);
  return {
    asOf,
    byStatus: ISSUE_STATUSES.flatMap((status) => {
      const count = tally.get(status) ?? 0;
      return count > 0 ? [{ status, count }] : [];
    }),
    open: issues.counts.open,
    running: running.slice(0, PROJECT_STATUS_ROWS).map((i) => ({
      key: i.key,
      title: i.title,
      status: i.status,
      waitingOn: i.standing.waitingOn,
    })),
    runningCount: running.length,
    truncated: issues.returned < issues.counts.open,
  };
}

function waitsOf(rows: Record<string, AttentionRow[]>, asOf: string): StatusWaits {
  const all = Object.entries(rows).flatMap(([area, list]) =>
    list.map((r) => ({ area, row: r })),
  );
  const people = all
    .filter(({ row }) => PERSON_KINDS.has(row.standing.waitingOn.kind))
    .sort((a, b) => (a.row.touchedAt ?? '').localeCompare(b.row.touchedAt ?? ''))
    .map(
      ({ area, row }): StatusWait => ({
        area: area as StatusWait['area'],
        entity: row.entity,
        key: row.key,
        title: row.title,
        waitingOn: row.standing.waitingOn,
        touchedAt: row.touchedAt,
      }),
    );
  return {
    asOf,
    people: people.slice(0, PROJECT_STATUS_ROWS),
    peopleCount: people.length,
    needsYou: all.filter(({ row }) => needsViewer(row.standing)).length,
  };
}

function requirementsOf(
  list: readonly RequirementSummary[],
  delivery: ReadonlyMap<string, DeliveryForecast | null>,
  asOf: string,
): StatusRequirements {
  const tally = new Map<RequirementState, number>();
  for (const r of list) tally.set(r.standing.state, (tally.get(r.standing.state) ?? 0) + 1);
  const items = list
    .filter((r) => LINE_STATES.has(r.standing.state))
    .map((r) => ({
      key: r.key,
      title: r.title,
      state: r.standing.state,
      criteria: {
        proven: r.delivery.criteriaCoverage.passing,
        total: r.delivery.criteriaCoverage.criteria,
      },
      issues: { shipped: r.delivery.closedIssues, live: r.delivery.liveIssues },
      waitingOn: r.standing.waitingOn,
      delivery: delivery.get(r.key) ?? null,
    }))
    .sort(
      (a, b) =>
        REQUIREMENT_STATES.indexOf(a.state) - REQUIREMENT_STATES.indexOf(b.state) || byKey(a, b),
    );
  return {
    asOf,
    proven: items.reduce((n, r) => n + r.criteria.proven, 0),
    total: items.reduce((n, r) => n + r.criteria.total, 0),
    byState: REQUIREMENT_STATES.map((state) => ({ state, count: tally.get(state) ?? 0 })),
    items,
  };
}

function nextReleaseOf(
  releases: ReleaseListResponse,
  draft: ScopeForecast,
  asOf: string,
): StatusNextRelease {
  const summary = releases.releases.find((r) => r.state === 'draft') ?? null;
  const leg = draft.delivery?.release;
  const cut = draft.next
    ? { who: draft.next.who, act: draft.next.act }
    : leg?.kind === 'person'
      ? { who: leg.who, act: leg.act }
      : null;
  return {
    asOf,
    version: summary?.version ?? null,
    issueCount: summary?.issueCount ?? 0,
    requirements: summary?.requirements ?? [],
    forecast: summary ? draft : null,
    cut: summary ? cut : null,
  };
}

const lateOfDelivery = (d: DeliveryForecast | null | undefined): ForecastLate | null => {
  const f = d?.landing;
  return f && (f.kind === 'forecast' || f.kind === 'paused') ? f.late : null;
};

const worst = (...lates: (ForecastLate | null)[]): ForecastLate | null =>
  lates.reduce<ForecastLate | null>((a, l) => (l && (!a || l.byMinutes > a.byMinutes) ? l : a), null);

function lateOf(
  coming: Awaited<ReturnType<typeof readForecastLine>>['coming'],
  feedback: Awaited<ReturnType<typeof readFeedbackForecasts>>,
  titles: { feedback: ReadonlyMap<string, string>; draft: string | null },
): StatusLate {
  const items: StatusLateItem[] = [];
  for (const s of coming.requirements) {
    const late = lateOfDelivery(s.delivery);
    if (late) items.push({ kind: 'requirement', key: s.key, title: s.title ?? s.key, late });
  }
  for (const f of feedback.items) {
    const late = worst(f.triage?.late ?? null, lateOfDelivery(f.delivery));
    if (late)
      items.push({ kind: 'feedback', key: f.key, title: titles.feedback.get(f.key) ?? f.key, late });
  }
  if (titles.draft !== null) {
    const late = worst(lateOfDelivery(coming.draft.delivery), coming.draft.next?.late ?? null);
    if (late) items.push({ kind: 'release', key: titles.draft, title: titles.draft, late });
  }
  items.sort((a, b) => b.late.byMinutes - a.late.byMinutes);
  const asOf = [coming.asOf, feedback.asOf].sort().at(-1) as string;
  return { asOf, items };
}

async function roadmapOf(
  list: readonly RequirementSummary[],
  coming: readonly ScopeForecast[],
  delivery: ReadonlyMap<string, DeliveryForecast | null>,
): Promise<StatusRoadmap> {
  const rank = new Map(coming.map((s, at) => [s.key, at]));
  const soonest = (a: { key: string }, b: { key: string }) =>
    (rank.get(a.key) ?? Number.POSITIVE_INFINITY) - (rank.get(b.key) ?? Number.POSITIVE_INFINITY) ||
    byKey(a, b);
  const item = (r: RequirementSummary, deferral: RoadmapItem['deferral'] = null): RoadmapItem => ({
    key: r.key,
    title: r.title,
    state: r.standing.state,
    delivery: delivery.get(r.key) ?? null,
    deferral,
  });
  const inState = (state: RequirementState) => list.filter((r) => r.standing.state === state);
  const deferred = await Promise.all(
    inState('deferred')
      .sort(byKey)
      .map(async (r) => {
        const d = await deferralOf(r.id, r.status);
        return item(
          r,
          d ? { reason: d.reason, targetPhase: d.targetPhase, deferredAt: d.deferredAt } : null,
        );
      }),
  );
  return {
    asOf: new Date().toISOString(),
    now: inState('in_delivery').sort(soonest).map((r) => item(r)),
    next: inState('agreed').sort(soonest).map((r) => item(r)),
    later: [...deferred, ...inState('draft').sort(byKey).map((r) => item(r))],
  };
}

export async function readProjectStatus(
  projectId: string,
  viewer: StatusViewer,
  days: number,
  now: Date = new Date(),
): Promise<ProjectStatus> {
  const since = new Date(now.getTime() - days * DAY_MS);
  const [head, attention, line, feedback, people] = await Promise.all([
    projectOrgHead(projectId),
    stamped(readAttention(projectId, viewer, now)),
    readForecastLine(projectId, now),
    readFeedbackForecasts({ userId: viewer.userId, agency: viewer.agency }, projectId, now),
    peopleOf([viewer.userId]),
  ]);
  if (!head) throw new Error(`project status: project ${projectId} has no head row`);
  const { value: read, at } = attention;
  const delivery = new Map(line.requirements.map((s) => [s.key, s.delivery]));
  const draftVersion = read.releases.releases.find((r) => r.state === 'draft')?.version ?? null;
  return {
    projectId,
    slug: head.slug,
    name: head.name,
    asOf: now.toISOString(),
    days,
    viewer: { id: viewer.userId, name: people.get(viewer.userId)?.name ?? null },
    shipped: shippedOf(read.releases, line.requirements, since, at),
    inFlight: inFlightOf(read.issues, at),
    waits: waitsOf(read.rows, at),
    requirements: requirementsOf(read.requirements, delivery, at),
    nextRelease: nextReleaseOf(read.releases, line.coming.draft, line.coming.asOf),
    late: lateOf(line.coming, feedback, {
      feedback: new Map(read.feedback.map((f) => [f.key, f.title])),
      draft: draftVersion,
    }),
    roadmap: await roadmapOf(read.requirements, line.coming.requirements, delivery),
  };
}
