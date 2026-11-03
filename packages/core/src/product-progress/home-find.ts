// The home's search (ISS-919): any issue or feedback item of a project the person reads, by its key
// or a title word, with where it stands — live (where, since when, in which version), moving (its
// stage) or ended — from the same reads Moving and Live use.

import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { HomeFoundItem, HomeFoundStanding } from '@forge/contracts/owner-home';
import { HOME_FIND_LIMIT } from '@forge/contracts/owner-home';
import type { ReleaseListResponse } from '@forge/contracts/releases';
import { issueDisplayIds, listIssues } from '../issues/index.js';
import { feedbackProgress } from './feedback-views.js';
import { wentLiveIn } from './home-live.js';
import { carriersOf, type HomeProject, type HomeProjectReads } from './home-moving.js';
import { feedbackEnded, feedbackStage, issueStage } from './home-stage.js';

const KEY = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** The project's first `HOME_FIND_LIMIT` matching issues, and how many match in all. */
async function issuesMatching(projectId: string, q: string) {
  const page = { sort: 'updatedAt:desc', limit: HOME_FIND_LIMIT, offset: 0 } as const;
  const found = KEY.test(q)
    ? await listIssues(projectId, { key: q }, page)
    : await listIssues(projectId, { search: q }, page);
  // a key the issue list refuses (FB-12, another prefix) names no issue of the project: none match
  if (!found.ok && found.field === 'key') return { rows: [], total: 0 };
  if (!found.ok) {
    throw new Error(
      `home find: the issue list refused its own read (${found.field}: ${found.message})`,
    );
  }
  const keys = await issueDisplayIds(found.rows.map((r) => r.id));
  const rows = found.rows.flatMap((r) => {
    const key = keys.get(r.id);
    return key ? [{ key, row: r }] : [];
  });
  return { rows, total: found.total };
}

function feedbackMatching(all: readonly FeedbackSummary[], q: string): FeedbackSummary[] {
  if (KEY.test(q)) return all.filter((s) => s.key.toLowerCase() === q.toLowerCase());
  const word = q.toLowerCase();
  return all.filter((s) => s.title.toLowerCase().includes(word));
}

function feedbackStanding(
  s: FeedbackSummary,
  part: HomeProjectReads,
  releases: ReleaseListResponse,
): HomeFoundStanding {
  const progress = feedbackProgress(s, part.reads);
  const ended = feedbackEnded(s, progress);
  if (ended === 'declined' || ended === 'answered') return { kind: 'ended', how: ended };
  if (ended === 'shipped') {
    const live = wentLiveIn(releases, carriersOf(s, part.reads));
    return live ? { kind: 'live', ...live } : { kind: 'ended', how: 'closed' };
  }
  return { kind: 'moving', stage: feedbackStage(s, progress) };
}

function issueStanding(
  key: string,
  status: string,
  claimed: boolean,
  part: HomeProjectReads,
  releases: ReleaseListResponse,
): HomeFoundStanding {
  if (status === 'dropped') return { kind: 'ended', how: 'dropped' };
  if (status === 'closed') {
    const live = wentLiveIn(releases, [key]);
    return live ? { kind: 'live', ...live } : { kind: 'ended', how: 'closed' };
  }
  const stage = issueStage(status, part.running.has(key), claimed) ?? 'planned';
  return { kind: 'moving', stage };
}

/** One project's matches for `q`, and how many matched before its issue list's own cut. */
export async function findIn(
  project: HomeProject,
  part: HomeProjectReads,
  releases: ReleaseListResponse,
  q: string,
): Promise<{ items: HomeFoundItem[]; total: number }> {
  const of = { projectSlug: project.slug, projectName: project.name };
  const issues = await issuesMatching(project.id, q);
  const fromIssues = issues.rows.map(
    ({ key, row }): HomeFoundItem => ({
      kind: 'issue',
      key,
      title: row.title,
      ...of,
      standing: issueStanding(key, row.status, row.releaseBatchRunId !== null, part, releases),
    }),
  );
  const fromFeedback = feedbackMatching(part.allFeedback, q).map(
    (s): HomeFoundItem => ({
      kind: 'feedback',
      key: s.key,
      title: s.title,
      ...of,
      standing: feedbackStanding(s, part, releases),
    }),
  );
  return {
    items: [...fromIssues, ...fromFeedback],
    total: issues.total + fromFeedback.length,
  };
}

/** Every project's matches, an exact key first, at most `HOME_FIND_LIMIT`. */
export function rankFound(q: string, found: readonly HomeFoundItem[]): HomeFoundItem[] {
  const exact = (f: HomeFoundItem) => (f.key.toLowerCase() === q.toLowerCase() ? 0 : 1);
  return [...found].sort((a, b) => exact(a) - exact(b)).slice(0, HOME_FIND_LIMIT);
}
