/**
 * How a project stands, in one read (JU-1, JU-3, JU-4, JU-10): assembled from the read models the
 * dashboard, Releases and Requirements already draw — the needs-you rows and the lists behind them
 * (`development`), and one forecast simulation (`forecast`) — so the status report, the assistant's
 * answer and the screens it summarises read the same numbers. It derives nothing those models do
 * not already decide: lateness is the forecast's, whom a row waits on is its own read model's.
 */

import type {
  DeliveryForecast,
  ForecastLate,
  ForecastMove,
  IssueProgress,
  ScopeForecast,
} from '@forge/contracts/forecast';
import { ISSUE_STATUSES } from '@forge/contracts/issue-machine';
import { NEEDS_YOU_AREA_SPACE, type NeedsYouAreaKey } from '@forge/contracts/needs-you';
import type { ActorAgency } from '@forge/contracts/permissions';
import {
  PROJECT_STATUS_ROWS,
  type ProjectStatus,
  provenInFull,
  ROADMAP_HORIZON_OF,
  type RoadmapHorizon,
  type RoadmapItem,
  type StatusInFlight,
  type StatusLate,
  type StatusLateItem,
  type StatusNextRelease,
  type StatusRequirements,
  type StatusRoadmap,
  type StatusShipped,
  type StatusWait,
  type StatusWaitPerson,
  type StatusWaits,
} from '@forge/contracts/project-status';
import type { ReleaseListResponse, ReleaseState, ReleaseSummary } from '@forge/contracts/releases';
import {
  REQUIREMENT_STATES,
  type RequirementState,
  type RequirementSummary,
} from '@forge/contracts/requirements';
import { needsViewer, type WaitingKind } from '@forge/contracts/standing';
import {
  type AttentionRow,
  type NeedsYouViewer,
  needsYouViewerOf,
  readAttention,
} from '../development/index.js';
import { issueProgressOf, readFeedbackForecasts, readForecastLine } from '../forecast/index.js';
import type { ProjectAccess } from '../lib/authz.js';
import { peopleOf } from '../lib/people.js';
import { holds } from '../permissions/index.js';
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

/** The reader: whom the needs-you rows name as You, and whose act a forecast's person leg is. */
export interface StatusViewer extends NeedsYouViewer {
  canWrite: boolean;
}

export const statusViewerOf = (
  access: ProjectAccess,
  userId: string,
  agency: ActorAgency,
): StatusViewer => ({
  ...needsYouViewerOf(access, userId, agency),
  canWrite: holds(access, 'project.write'),
});

const NO_PROGRESS: IssueProgress = { total: 0, shipped: 0, awaitingRelease: 0, toDo: 0 };

/** A promise's value and the moment it answered, so each section says when it was read. */
async function stamped<T>(p: Promise<T>): Promise<{ value: T; at: string }> {
  const value = await p;
  return { value, at: new Date().toISOString() };
}

/**
 * The requirements whose last issue shipped inside the window, split by proof: delivered in full only
 * where every live criterion is proven (`provenInFull`, the rule a release's `completes` reads), and
 * shipped-awaiting-proof otherwise — never "delivered in full" on a criterion nobody judged.
 */
export function requirementsShippedOf(
  scopes: readonly Pick<ScopeForecast, 'key' | 'title' | 'delivery'>[],
  requirements: readonly Pick<RequirementSummary, 'key' | 'delivery'>[],
  since: Date,
) {
  const coverage = new Map(requirements.map((r) => [r.key, r.delivery.criteriaCoverage]));
  const inFull: StatusShipped['requirementsShipped'] = [];
  const awaitingProof: NonNullable<StatusShipped['requirementsAwaitingProof']> = [];
  for (const s of scopes) {
    const at = s.delivery?.shipped?.at ?? null;
    if (!at || Date.parse(at) < since.getTime()) continue;
    const c = coverage.get(s.key);
    if (!c)
      throw new Error(
        `project status: ${s.key} shipped and the requirements list read no coverage for it — the forecast and the list read one set`,
      );
    const proof = { proven: c.passing, total: c.criteria };
    const row = { key: s.key, title: s.title ?? s.key, at };
    if (provenInFull(proof)) inFull.push(row);
    else awaitingProof.push({ ...row, ...proof });
  }
  const newest = (a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);
  return { inFull: inFull.sort(newest), awaitingProof: awaitingProof.sort(newest) };
}

function shippedOf(
  releases: ReleaseListResponse,
  scopes: readonly ScopeForecast[],
  requirements: readonly RequirementSummary[],
  since: Date,
  asOf: string,
): StatusShipped {
  const shipped = releases.releases
    .filter((r) => r.state === 'shipped' && r.releasedAt !== null)
    .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''));
  const inWindow = shipped.filter((r) => Date.parse(r.releasedAt as string) >= since.getTime());
  const view = (r: ReleaseSummary) => ({
    version: r.version,
    releasedAt: r.releasedAt as string,
    headline: r.headline,
    issueCount: r.issueCount,
    requirements: r.requirements,
    contents: r.contents,
    verified: r.verified,
  });
  const { inFull: requirementsShipped, awaitingProof: requirementsAwaitingProof } =
    requirementsShippedOf(scopes, requirements, since);
  // the counts lead and the lists follow, so a reader cut short (a chat result's grounding cap)
  // still holds every figure the section states
  return {
    asOf,
    since: since.toISOString(),
    releaseCount: inWindow.length,
    issueCount: inWindow.reduce((n, r) => n + r.issueCount, 0),
    requirementsShipped,
    requirementsAwaitingProof,
    latest: shipped[0] ? view(shipped[0]) : null,
    releases: inWindow.slice(0, PROJECT_STATUS_ROWS).map(view),
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
      titleLang: i.writtenLang,
      status: i.status,
      waitingOn: i.standing.waitingOn,
    })),
    runningCount: running.length,
    truncated: issues.returned < issues.counts.open,
  };
}

const personKey = (w: StatusWait['waitingOn']) => `${w.kind}:${JSON.stringify(w.says.who)}`;

/**
 * The member asks whose turn is a person's, grouped by that person: the one owing most first, each
 * person's oldest row first. A row of an ops area (`NEEDS_YOU_AREA_SPACE`) is Development's — an
 * agent report's triage is Forge upkeep, not something a project member was asked — and is not here.
 */
export function waitsOf(rows: Record<string, AttentionRow[]>, asOf: string): StatusWaits {
  const all = Object.entries(rows).flatMap(([area, list]) =>
    NEEDS_YOU_AREA_SPACE[area as NeedsYouAreaKey] === 'asks'
      ? list.map((r) => ({ area: area as NeedsYouAreaKey, row: r }))
      : [],
  );
  const owed = all
    .filter(({ row }) => PERSON_KINDS.has(row.standing.waitingOn.kind))
    .map(
      ({ area, row }): StatusWait => ({
        area,
        entity: row.entity,
        key: row.key,
        title: row.title,
        titleLang: row.titleLang,
        waitingOn: row.standing.waitingOn,
        touchedAt: row.touchedAt,
        says: { title: row.says.title },
      }),
    );
  const groups = new Map<string, { person: StatusWaitPerson; rows: StatusWait[] }>();
  for (const w of owed) {
    const key = personKey(w.waitingOn);
    const g = groups.get(key) ?? {
      person: {
        kind: w.waitingOn.kind,
        who: w.waitingOn.who,
        says: { who: w.waitingOn.says.who },
        count: 0,
      },
      rows: [],
    };
    g.person.count += 1;
    g.rows.push(w);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      Number(b.person.kind === 'you') - Number(a.person.kind === 'you') ||
      b.person.count - a.person.count ||
      a.person.who.localeCompare(b.person.who),
  );
  const people = ordered.flatMap((g) =>
    [...g.rows].sort((a, b) => (a.touchedAt ?? '').localeCompare(b.touchedAt ?? '')),
  );
  return {
    asOf,
    people: people.slice(0, PROJECT_STATUS_ROWS),
    byPerson: ordered.map((g) => g.person),
    peopleCount: people.length,
    needsYou: all.filter(({ row }) => needsViewer(row.standing)).length,
  };
}

function requirementsOf(
  list: readonly RequirementSummary[],
  scopes: ReadonlyMap<string, ScopeForecast>,
  asOf: string,
): StatusRequirements {
  const scopeOf = (key: string): ScopeForecast => {
    const s = scopes.get(key);
    if (!s)
      throw new Error(
        `project status: ${key} is on the delivery line and the forecast read no scope for it — every requirement not dropped has one`,
      );
    return s;
  };
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
      progress: scopeOf(r.key).progress,
      waitingOn: r.standing.waitingOn,
      delivery: scopeOf(r.key).delivery,
      moved: scopeOf(r.key).moved,
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

/** A release cut and not yet in people's hands, nor ended. */
const ON_ITS_WAY: ReadonlySet<ReleaseState> = new Set([
  'in_progress',
  'awaiting_approval',
  'returned',
]);

const progressOfRelease = (r: ReleaseSummary): IssueProgress =>
  issueProgressOf(r.contents.flatMap((g) => g.issues));

function nextReleaseOf(
  releases: ReleaseListResponse,
  draft: ScopeForecast,
  asOf: string,
): StatusNextRelease {
  const summary = releases.releases.find((r) => r.state === 'draft') ?? null;
  const cut = releases.releases
    .filter((r) => ON_ITS_WAY.has(r.state))
    .sort((a, b) => (a.openedAt ?? a.at).localeCompare(b.openedAt ?? b.at))[0];
  if (cut) {
    const w = cut.waitingOn;
    return {
      asOf,
      version: cut.version,
      state: cut.state,
      progress: progressOfRelease(cut),
      requirements: cut.requirements,
      forecast: null,
      turn: w.act ? { who: w.who, act: w.act, says: { who: w.says.who, act: w.says.act } } : null,
      behind:
        summary && summary.issueCount > 0
          ? { version: summary.version, issueCount: summary.issueCount }
          : null,
    };
  }
  const leg = draft.delivery?.release;
  const turn = draft.next
    ? {
        who: draft.next.who,
        act: draft.next.act,
        says: { who: draft.next.says.who, act: draft.next.says.act },
      }
    : leg?.kind === 'person'
      ? { who: leg.who, act: leg.act, says: { who: leg.says.who, act: leg.says.act } }
      : null;
  return {
    asOf,
    version: summary?.version ?? null,
    state: summary?.state ?? null,
    progress: summary ? draft.progress : NO_PROGRESS,
    requirements: summary?.requirements ?? [],
    forecast: summary ? draft : null,
    turn: summary ? turn : null,
    behind: null,
  };
}

const lateOfDelivery = (d: DeliveryForecast | null | undefined): ForecastLate | null => {
  const f = d?.landing;
  return f && (f.kind === 'forecast' || f.kind === 'paused') ? f.late : null;
};

const worst = (...lates: (ForecastLate | null)[]): ForecastLate | null =>
  lates.reduce<ForecastLate | null>(
    (a, l) => (l && (!a || l.byMinutes > a.byMinutes) ? l : a),
    null,
  );

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
      items.push({
        kind: 'feedback',
        key: f.key,
        title: titles.feedback.get(f.key) ?? f.key,
        late,
      });
  }
  if (titles.draft !== null) {
    const late = worst(lateOfDelivery(coming.draft.delivery), coming.draft.next?.late ?? null);
    if (late) items.push({ kind: 'release', key: titles.draft, title: titles.draft, late });
  }
  items.sort((a, b) => b.late.byMinutes - a.late.byMinutes);
  const asOf = [coming.asOf, feedback.asOf].sort().at(-1) as string;
  return { asOf, items };
}

/** The requirements on one roadmap lane, by the one lane rule (`ROADMAP_HORIZON_OF`, REQ-33 BC-3). */
export function onLane<R extends { standing: { state: RequirementState } }>(
  list: readonly R[],
  lane: RoadmapHorizon,
): R[] {
  return list.filter((r) => ROADMAP_HORIZON_OF[r.standing.state] === lane);
}

async function roadmapOf(
  list: readonly RequirementSummary[],
  coming: readonly ScopeForecast[],
  delivery: ReadonlyMap<string, DeliveryForecast | null>,
  moved: ReadonlyMap<string, ForecastMove | null> = new Map(),
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
    moved: moved.get(r.key) ?? null,
    deferral,
  });
  const onHorizon = (h: RoadmapHorizon) => onLane(list, h);
  // Later reads what was deferred first, with why and to which phase, then what is not agreed yet
  const later = onHorizon('later');
  const deferred = await Promise.all(
    later
      .filter((r) => r.standing.state === 'deferred')
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
    now: onHorizon('now')
      .sort(soonest)
      .map((r) => item(r)),
    next: onHorizon('next')
      .sort(soonest)
      .map((r) => item(r)),
    later: [
      ...deferred,
      ...later
        .filter((r) => r.standing.state !== 'deferred')
        .sort(byKey)
        .map((r) => item(r)),
    ],
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
    readForecastLine(projectId, viewer, now),
    readFeedbackForecasts({ userId: viewer.userId, agency: viewer.agency }, projectId, viewer, now),
    peopleOf([viewer.userId]),
  ]);
  if (!head) throw new Error(`project status: project ${projectId} has no head row`);
  const { value: read, at } = attention;
  const scopes = new Map(line.requirements.map((s) => [s.key, s]));
  const delivery = new Map(line.requirements.map((s) => [s.key, s.delivery]));
  const moved = new Map(line.requirements.map((s) => [s.key, s.moved]));
  const draftVersion = read.releases.releases.find((r) => r.state === 'draft')?.version ?? null;
  return {
    projectId,
    slug: head.slug,
    name: head.name,
    asOf: now.toISOString(),
    days,
    viewer: { id: viewer.userId, name: people.get(viewer.userId)?.name ?? null },
    // the small sections first and the long lists last, for the reader a cap cuts short
    nextRelease: nextReleaseOf(read.releases, line.coming.draft, line.coming.asOf),
    inFlight: inFlightOf(read.issues, at),
    late: lateOf(line.coming, feedback, {
      feedback: new Map(read.feedback.map((f) => [f.key, f.title])),
      draft: draftVersion,
    }),
    shipped: shippedOf(read.releases, line.requirements, read.requirements, since, at),
    requirements: requirementsOf(read.requirements, scopes, at),
    waits: waitsOf(read.rows, at),
    roadmap: await roadmapOf(read.requirements, line.coming.requirements, delivery, moved),
  };
}
