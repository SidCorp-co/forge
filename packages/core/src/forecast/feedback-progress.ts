/**
 * One feedback item's progress as its reader asks it: is work on it running, which issues carry it
 * and at what status, and when it is done or why no date can be given. The line is the feedback
 * forecast's own (`feedback.ts`), read from the same simulation as the list's, so the item's page and
 * its row never give two answers; the work and the estimate are decided here, once, for every door.
 */

import { FEEDBACK_UNTRIAGED_PHASES, type FeedbackSummary } from '@forge/contracts/feedback';
import {
  deliveryDatesOf,
  type FeedbackEstimate,
  type FeedbackForecast,
  type FeedbackNoEstimateReason,
  type FeedbackProgress,
  type FeedbackWork,
  type FeedbackWorkIssue,
  type FeedbackWorkState,
  type ForecastWaitSays,
} from '@forge/contracts/forecast';
import { PARK_STATUSES, TAKEABLE_STATUSES } from '@forge/contracts/issue-machine';
import type { ActorAgency } from '@forge/contracts/permissions';
import { requirementKey } from '@forge/contracts/requirements';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { rowIn } from '../feedback/index.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { type LinkRow, readFeedbackLines } from './feedback.js';
import { stamp } from './read.js';
import type { ForecastViewer } from './release.js';

/** Work queued for a run is work a master may take: admitted, not started, not parked. */
const QUEUED: readonly string[] = TAKEABLE_STATUSES;

/**
 * The work's state off its issues' statuses, running first: an item is running while any issue is in
 * progress, whatever the others read, since that is the question its reader asks.
 */
export function workStateOf(
  statuses: readonly string[],
): Pick<FeedbackWork, 'state' | 'running' | 'total'> {
  const live = statuses.filter((s) => s !== 'dropped');
  const count = (pick: (s: string) => boolean) => live.filter(pick).length;
  const running = count((s) => s === 'in_progress');
  const total = live.length;
  const state: FeedbackWorkState =
    total === 0
      ? statuses.length > 0
        ? 'ended'
        : 'no_issues'
      : running > 0
        ? 'running'
        : count((s) => (PARK_STATUSES as readonly string[]).includes(s)) > 0
          ? 'parked'
          : count((s) => QUEUED.includes(s)) > 0
            ? 'queued'
            : count((s) => s === 'draft') > 0
              ? 'drafted'
              : count((s) => s === 'awaiting_release') > 0
                ? 'landed'
                : 'shipped';
  return { state, running, total };
}

/** The route the item's work follows: its own, or its root's where it is a duplicate. */
type Carried = Pick<FeedbackSummary, 'route' | 'phase' | 'snoozed'>;

/** The item as its estimate reads it: its route, and the standing its banner draws. */
type Item = Carried & Pick<FeedbackSummary, 'waitingOn' | 'times'>;

/** What the item waits on, as its standing says it: the stuck reason where it is stuck (REQ-48 BC-8). */
const standingSays = (item: Item): ForecastWaitSays => ({
  who: item.waitingOn.says.who,
  act: item.waitingOn.says.act,
  reason: item.times.stuck?.says.reason ?? item.waitingOn.says.rule,
});

const none = (
  reason: FeedbackNoEstimateReason,
  more: {
    waits?: ForecastWaitSays | null;
    history?: { n: number; floor: number } | null;
    until?: string | null;
  } = {},
): FeedbackEstimate => ({
  kind: 'none',
  reason,
  waits: more.waits ?? null,
  history: more.history ?? null,
  until: more.until ?? null,
});

/**
 * The item's estimate off its line: the dates where the line holds a range, shipped once it has,
 * else the one reason no date is given. `item` is the item itself (its snooze, its triage and the
 * standing whose wait every wait here names, so the body and the banner say one thing), `carried`
 * the route whose work it reads (its root's for a duplicate).
 */
export function estimateOf(item: Item, carried: Carried, line: FeedbackForecast): FeedbackEstimate {
  if (line.triage) return none('untriaged', { waits: standingSays(item) });
  if (!item.route && item.snoozed) return none('snoozed', { until: item.snoozed.until });
  const d = line.delivery;
  if (!d) {
    if (carried.phase === 'declined') return none('no_work');
    if (!carried.route) return none('untriaged');
    const route = carried.route.route;
    return route === 'answer' || route === 'revision' ? none('no_work') : none('no_issues');
  }
  if (d.shipped) return { kind: 'shipped', version: d.shipped.version, at: d.shipped.at };
  const dates = deliveryDatesOf(d);
  if (dates) return { kind: 'dated', ...dates };
  const landing = d.landing;
  switch (landing.kind) {
    case 'paused':
      return none('waits', { waits: standingSays(item) });
    case 'not_enough_history':
      return none('history', { history: { n: landing.n, floor: landing.floor } });
    case 'ended':
      return none('ended');
    case 'landed': {
      const leg = d.release;
      if (leg?.kind === 'person') return none('release_waits', { waits: leg.says });
      if (leg?.kind === 'not_enough_history') {
        return none('release_history', { history: { n: leg.n, floor: leg.floor } });
      }
      break;
    }
    case 'forecast':
      break;
  }
  throw new Error(
    `forecast: the line of ${line.key} holds a ${landing.kind} landing with no dates and no named wait; delivery.ts:deliveryOf gives a landed or forecast landing a release leg or a span`,
  );
}

interface WorkIssueRow {
  iss_seq: number;
  title: string;
  status: string;
}

/** The issues an issue route names, or every issue of the requirement a new-requirement route opened. */
async function issuesOf(
  projectId: string,
  route: 'issue' | 'new_requirement',
  link: LinkRow,
): Promise<FeedbackWorkIssue[]> {
  const ids = link.issue_ids ?? [];
  const where =
    route === 'new_requirement'
      ? link.routed_requirement_id
        ? sql`i.requirement_id = ${link.routed_requirement_id}`
        : null
      : ids.length > 0
        ? sql`i.id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`
        : null;
  if (!where) return [];
  const [rows, prefix] = await Promise.all([
    db.execute(sql`
      SELECT i.iss_seq, i.title, i.status FROM issues i
       WHERE i.project_id = ${projectId} AND i.archived_at IS NULL AND ${where}
       ORDER BY i.iss_seq`),
    activeIssuePrefix(projectId),
  ]);
  return rowsOf<WorkIssueRow>(rows).map((r) => ({
    key: formatIssueRef(prefix, r.iss_seq),
    title: r.title,
    status: r.status,
  }));
}

async function requirementOf(id: string): Promise<FeedbackWork['requirement']> {
  const [row] = rowsOf<{ req_seq: number; title: string; status: string }>(
    await db.execute(sql`SELECT req_seq, title, status FROM requirements WHERE id = ${id}`),
  );
  if (!row) throw new Error(`forecast: feedback routes to requirement ${id}, which no row holds`);
  return { key: requirementKey(row.req_seq), title: row.title, status: row.status };
}

/** The work carrying `carried`: the issues of its issue route, or of the requirement it opened. */
async function workOf(
  projectId: string,
  carried: FeedbackSummary,
  link: LinkRow | undefined,
  duplicateOf: string | null,
): Promise<FeedbackWork> {
  const base = { requirement: null, duplicateOf, issues: [] as FeedbackWorkIssue[] };
  const route = carried.route?.route;
  if (carried.phase === 'declined') return { ...base, state: 'no_work', running: 0, total: 0 };
  if (!route || (FEEDBACK_UNTRIAGED_PHASES as readonly string[]).includes(carried.phase)) {
    return { ...base, state: 'untriaged', running: 0, total: 0 };
  }
  if (route !== 'issue' && route !== 'new_requirement') {
    return { ...base, state: 'no_work', running: 0, total: 0 };
  }
  const issues = link ? await issuesOf(projectId, route, link) : [];
  const requirement =
    route === 'new_requirement' && link?.routed_requirement_id
      ? await requirementOf(link.routed_requirement_id)
      : null;
  return { ...base, requirement, issues, ...workStateOf(issues.map((i) => i.status)) };
}

export async function readFeedbackProgress(
  viewer: { userId: string; agency: ActorAgency },
  projectId: string,
  ref: string,
  forecastViewer: ForecastViewer | null,
  now: Date = new Date(),
): Promise<FeedbackProgress> {
  const row = await rowIn(db, projectId, ref);
  const read = await readFeedbackLines(viewer, projectId, forecastViewer, now);
  const item = read.items.find((s) => s.id === row.id);
  const line = read.lines.get(row.id);
  if (!item || !line) {
    throw new Error(
      `forecast: ${ref} was read but the feedback list holds no line for it; the list and the item read must see the same items`,
    );
  }
  const rootId = item.route?.route === 'duplicate' ? read.links.get(row.id)?.duplicate_of : null;
  const root = rootId ? read.items.find((s) => s.id === rootId) : undefined;
  const carried = root ?? item;
  const work = await workOf(projectId, carried, read.links.get(carried.id), root?.key ?? null);
  return {
    ...stamp(read.asOf),
    key: item.key,
    work,
    forecast: line,
    estimate: estimateOf(item, carried, line),
  };
}
