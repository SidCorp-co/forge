// One project's part of a person's home (ISS-919): the feedback they gave and the issues they own,
// each with its stage, who owes the next move and the forecast's held date. Composed from the reads
// the feedback page, the issue list and the board already serve; nothing here computes a date.

import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { HomeMovingItem } from '@forge/contracts/owner-home';
import type { ActorAgency } from '@forge/contracts/permissions';
import { listFeedbackAs } from '../feedback/index.js';
import { forecastViewerOf, readFeedbackForecasts, readProjectForecast } from '../forecast/index.js';
import { issueDisplayIds, issueWaitsOf, listIssues } from '../issues/index.js';
import { type FeedbackReads, feedbackProgress, routedRequirements } from './feedback-views.js';
import { feedbackEnded, feedbackStage, issueStage } from './home-stage.js';
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
  issues: { id: string; key: string; title: string; status: string; claimed: boolean }[];
  /** Issue keys a live run works now. */
  running: Set<string>;
  reads: FeedbackReads;
}

const OWNED_LIMIT = 200;
const PAGE = { sort: 'updatedAt:desc', limit: OWNED_LIMIT, offset: 0 } as const;

async function ownedIssues(projectId: string, userId: string) {
  const [created, held] = await Promise.all([
    listIssues(projectId, { createdBy: userId }, PAGE),
    listIssues(projectId, { assigneeId: userId }, PAGE),
  ]);
  const rows = new Map(
    [...(created.ok ? created.rows : []), ...(held.ok ? held.rows : [])].map((r) => [r.id, r]),
  );
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

/** The project's Moving rows: their feedback not yet live, then their issues not yet over. */
export async function movingOf(
  project: HomeProject,
  part: HomeProjectReads,
): Promise<HomeMovingItem[]> {
  const of = { projectSlug: project.slug, projectName: project.name };
  const fromFeedback = part.feedback.flatMap(({ s, progress }): HomeMovingItem[] => {
    if (feedbackEnded(s, progress)) return [];
    const wait = progress.waitingOn[0];
    return [
      {
        kind: 'feedback',
        key: s.key,
        title: s.title,
        ...of,
        stage: feedbackStage(s, progress),
        running: progress.running,
        owes: wait ? { who: wait.who, act: wait.act } : ownerOf(s),
        likelyBy: progress.eta.estimate ? progress.eta.likelyBy : null,
        noDate: progress.eta.estimate ? null : progress.eta.why,
      },
    ];
  });
  const open = part.issues.filter((i) => issueStage(i.status, false, i.claimed) !== null);
  if (open.length === 0) return fromFeedback;
  const [waits, forecast] = await Promise.all([
    issueWaitsOf(
      project.id,
      open.map((i) => i.id),
      null,
    ),
    readProjectForecast(project.id, null),
  ]);
  const dates = new Map(forecast.issues.map((f) => [f.key, f.forecast]));
  const fromIssues = open.map((i): HomeMovingItem => {
    const running = part.running.has(i.key) || runsOn(part.reads.runs, [i.key]).length > 0;
    const w = waits.get(i.id)?.standing.waitingOn;
    const f = dates.get(i.key);
    return {
      kind: 'issue',
      key: i.key,
      title: i.title,
      ...of,
      stage: issueStage(i.status, running, i.claimed) ?? 'planned',
      running: part.running.has(i.key),
      owes: w && w.kind !== 'none' ? { who: w.who, act: w.act } : null,
      likelyBy: f?.kind === 'forecast' ? f.p50At : null,
      noDate: f?.kind === 'paused' ? f.reason : null,
    };
  });
  return [...fromFeedback, ...fromIssues];
}

function ownerOf(s: FeedbackSummary): { who: string; act: string } | null {
  return s.waitingOn.kind === 'none' ? null : { who: s.waitingOn.who, act: s.waitingOn.act };
}
