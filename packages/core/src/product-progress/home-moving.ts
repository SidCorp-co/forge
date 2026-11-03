// One project's part of a person's home (ISS-919): the feedback they gave and the issues they own,
// each with its stage, who owes the next move and the forecast's held date. An item whose next move
// the viewer owes (a wait whose `you` its standing set) is theirs to take, so it is a Waiting row and
// never a Moving one. Composed from the reads the feedback page, the issue list and the board already
// serve; nothing here computes a date.

import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { HomeMovingItem, HomeWaitingItem } from '@forge/contracts/owner-home';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { RunStanding } from '@forge/contracts/run-standing';
import { listFeedbackAs } from '../feedback/index.js';
import { forecastViewerOf, readFeedbackForecasts, readProjectForecast } from '../forecast/index.js';
import { issueDisplayIds, issueWaitsOf, listIssues } from '../issues/index.js';
import { type FeedbackReads, feedbackProgress, routedRequirements } from './feedback-views.js';
import { feedbackEnded, feedbackStage, isIdle, issueStage, lastMoveOf } from './home-stage.js';
import {
  issuesOfRequirements,
  liveRunsByIssue,
  type Progress,
  requirementIdsOf,
  runsOn,
} from './progress.js';

export interface HomeProject {
  id: string;
  slug: string;
  name: string;
}

export interface HomeViewer {
  userId: string;
  agency: ActorAgency;
}

/** The person's own items of one project, read once, that Moving, Live and the search share. */
export interface HomeProjectReads {
  /** Their feedback items, each with its progress block. */
  feedback: { s: FeedbackSummary; progress: Progress }[];
  /** Every item of the project, for the search: summaries without progress. */
  allFeedback: FeedbackSummary[];
  /** The issues they filed or hold, at any status. */
  issues: {
    id: string;
    key: string;
    title: string;
    status: string;
    claimed: boolean;
    updatedAt: string;
  }[];
  /** Issue keys a live run works now. */
  running: Set<string>;
  reads: FeedbackReads;
}

/** Issues read a page at a time; every page is read, so Moving's total counts every one. */
const OWNED_PAGE = 200;

type IssueFilters = Parameters<typeof listIssues>[1];

/** Every issue of the project `filters` admits, page after page until a short one. */
async function allIssues(projectId: string, filters: IssueFilters) {
  const rows = [];
  for (let offset = 0; ; offset += OWNED_PAGE) {
    const page = await listIssues(projectId, filters, {
      sort: 'updatedAt:desc',
      limit: OWNED_PAGE,
      offset,
    });
    if (!page.ok) {
      throw new Error(`home: the issue list refused its own read (${page.field}: ${page.message})`);
    }
    rows.push(...page.rows);
    if (page.rows.length < OWNED_PAGE) return rows;
  }
}

async function ownedIssues(projectId: string, userId: string) {
  const [created, held] = await Promise.all([
    allIssues(projectId, { createdBy: userId }),
    allIssues(projectId, { assigneeId: userId }),
  ]);
  const rows = new Map([...created, ...held].map((r) => [r.id, r]));
  const keys = await issueDisplayIds([...rows.keys()]);
  return [...rows.values()].flatMap((r) => {
    const key = keys.get(r.id);
    return key
      ? [
          {
            id: r.id,
            key,
            title: r.title,
            status: r.status,
            claimed: r.releaseBatchRunId !== null,
            updatedAt: r.updatedAt.toISOString(),
          },
        ]
      : [];
  });
}

/** Reads one project's part as `viewer`; the caller has checked `project.read` on it. */
export async function readHomeProject(
  viewer: HomeViewer,
  projectId: string,
): Promise<HomeProjectReads> {
  const listed = await listFeedbackAs(viewer, projectId, {});
  const allFeedback = listed.ok ? listed.list.feedback : [];
  const fViewer = await forecastViewerOf(projectId, viewer.userId);
  const [forecasts, runs, reqIds, issues] = await Promise.all([
    readFeedbackForecasts(viewer, projectId, fViewer),
    liveRunsByIssue(projectId, viewer.userId),
    requirementIdsOf(projectId, routedRequirements(allFeedback)),
    ownedIssues(projectId, viewer.userId),
  ]);
  const reqIssues = await issuesOfRequirements(projectId, [...reqIds.values()]);
  const reads: FeedbackReads = {
    asOf: forecasts.asOf,
    forecasts: new Map(forecasts.items.map((f) => [f.key, f])),
    runs,
    requirementIssues: new Map([...reqIds].map(([key, id]) => [key, reqIssues.get(id) ?? []])),
    items: new Map(allFeedback.map((s) => [s.key, s])),
  };
  const mine = allFeedback.filter((s) => s.reporter.id === viewer.userId);
  const running = new Set(
    [...runs].filter(([, rs]) => rs.some((r) => r.state === 'running')).map(([k]) => k),
  );
  return {
    feedback: mine.map((s) => ({ s, progress: feedbackProgress(s, reads) })),
    allFeedback,
    issues,
    running,
    reads,
  };
}

/** The carrier issue keys of a feedback item's work, as its progress counted them. */
export function carriersOf(s: FeedbackSummary, reads: FeedbackReads): string[] {
  if (s.route?.route === 'issue') return s.route.carriers.flatMap((c) => (c.key ? [c.key] : []));
  if (s.route?.route === 'new_requirement') {
    const req = s.route.carriers[0]?.key;
    return req ? (reads.requirementIssues.get(req) ?? []).map((w) => w.key) : [];
  }
  return [];
}

/** A Waiting row with the last move it is ranked by, which the reply leaves out. */
export type HomeWaitingRanked = HomeWaitingItem & { lastMovedAt: string };

/** One project's items split by who owes the next move: someone else or nobody (Moving), or the viewer (Waiting). */
export interface HomeProjectItems {
  moving: HomeMovingItem[];
  waiting: HomeWaitingRanked[];
}

const runStarts = (runs: readonly RunStanding[]) => runs.map((r) => r.since);

/** The project's items not yet live: their feedback, then their issues not yet over. */
export async function homeItemsOf(
  project: HomeProject,
  part: HomeProjectReads,
  viewer: HomeViewer,
  now: Date = new Date(),
): Promise<HomeProjectItems> {
  const of = { projectSlug: project.slug, projectName: project.name };
  const out: HomeProjectItems = { moving: [], waiting: [] };
  for (const { s, progress } of part.feedback) {
    if (feedbackEnded(s, progress)) continue;
    const lastMovedAt = lastMoveOf(
      s.updatedAt,
      s.times.since,
      ...runStarts(runsOn(part.reads.runs, carriersOf(s, part.reads))),
    );
    const owed = progress.waitingOn.find((w) => w.you);
    if (owed) {
      out.waiting.push({
        kind: 'feedback',
        key: s.key,
        title: s.title,
        ...of,
        act: owed.act,
        lastMovedAt,
      });
      continue;
    }
    const wait = progress.waitingOn[0];
    out.moving.push({
      kind: 'feedback',
      key: s.key,
      title: s.title,
      ...of,
      stage: feedbackStage(s, progress),
      running: progress.running,
      owes: wait ? { who: wait.who, act: wait.act } : ownerOf(s),
      likelyBy: progress.eta.estimate ? progress.eta.likelyBy : null,
      noDate: progress.eta.estimate ? null : progress.eta.why,
      lastMovedAt,
      idle: isIdle(lastMovedAt, progress.running, now),
    });
  }
  const open = part.issues.filter((i) => issueStage(i.status, false, i.claimed) !== null);
  if (open.length === 0) return out;
  const [waits, forecast] = await Promise.all([
    issueWaitsOf(
      project.id,
      open.map((i) => i.id),
      { userId: viewer.userId },
      now,
    ),
    readProjectForecast(project.id, null),
  ]);
  const dates = new Map(forecast.issues.map((f) => [f.key, f.forecast]));
  for (const i of open) {
    const runs = runsOn(part.reads.runs, [i.key]);
    const running = part.running.has(i.key);
    const standing = waits.get(i.id)?.standing;
    const w = standing?.waitingOn;
    const lastMovedAt = lastMoveOf(i.updatedAt, standing?.times.since, ...runStarts(runs));
    if (w?.kind === 'you') {
      out.waiting.push({
        kind: 'issue',
        key: i.key,
        title: i.title,
        ...of,
        act: w.act,
        lastMovedAt,
      });
      continue;
    }
    const f = dates.get(i.key);
    out.moving.push({
      kind: 'issue',
      key: i.key,
      title: i.title,
      ...of,
      stage: issueStage(i.status, running || runs.length > 0, i.claimed) ?? 'planned',
      running,
      owes: w && w.kind !== 'none' ? { who: w.who, act: w.act } : null,
      likelyBy: f?.kind === 'forecast' ? f.p50At : null,
      noDate: f?.kind === 'paused' ? f.reason : null,
      lastMovedAt,
      idle: isIdle(lastMovedAt, running, now),
    });
  }
  return out;
}

function ownerOf(s: FeedbackSummary): { who: string; act: string } | null {
  return s.waitingOn.kind === 'none' ? null : { who: s.waitingOn.who, act: s.waitingOn.act };
}
