// The home's search (ISS-919): any issue or feedback item of a project the person reads, found
// through the find door (ISS-1256), with where it stands — live (where, since when, in which
// version), moving (its stage) or ended — from the same reads Moving and Live use.

import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { HomeFoundItem, HomeFoundStanding } from '@forge/contracts/owner-home';
import { HOME_FIND_LIMIT } from '@forge/contracts/owner-home';
import type { ReleaseListResponse } from '@forge/contracts/releases';
import { type IssueNative, runFind } from '../find/index.js';
import type { ProjectReader } from '../lib/authz.js';
import { feedbackProgress } from './feedback-views.js';
import { wentLiveIn } from './home-live.js';
import { carriersOf, type HomeProject, type HomeProjectReads } from './home-moving.js';
import { feedbackEnded, feedbackStage, issueStage } from './home-stage.js';

/**
 * The project's issues and feedback items matching `q`, as a filter of the find door (ISS-1256): the
 * hits its issue and feedback filter keeps, in its order, and how many of those types it found. A
 * home search spans projects, so a miss in one is no gap of that project's.
 */
async function matching(projectId: string, q: string, reader: ProjectReader) {
  const { kept, result } = await runFind({
    projectId,
    projectIds: [projectId],
    query: { q, type: [...HOME_FIND_TYPES], limit: HOME_FIND_LIMIT },
    reader,
    askedBy: 'person',
    recordsGap: false,
    filterOnly: true,
  });
  const total = result.facets.type
    .filter((f) => (HOME_FIND_TYPES as readonly string[]).includes(f.value))
    .reduce((n, f) => n + f.count, 0);
  return { kept, total };
}

const HOME_FIND_TYPES = ['issue', 'feedback'] as const;

/** A found item and the door's fused score it was found at, which orders it among every project's. */
export interface HomeFound {
  item: HomeFoundItem;
  score: number;
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

/** One project's matches for `q`, at most `HOME_FIND_LIMIT` of them, and how many the door found. */
export async function findIn(
  project: HomeProject,
  part: HomeProjectReads,
  releases: ReleaseListResponse,
  q: string,
  reader: ProjectReader,
): Promise<{ found: HomeFound[]; total: number }> {
  const of = { projectSlug: project.slug, projectName: project.name };
  const { kept, total } = await matching(project.id, q, reader);
  const feedbackById = new Map(part.allFeedback.map((s) => [s.id, s]));
  const found = kept.flatMap((c): HomeFound[] => {
    if (c.type === 'issue' && c.key) {
      const claimed = (c.native as IssueNative | undefined)?.releaseBatchRunId != null;
      const standing = issueStanding(c.key, c.status ?? '', claimed, part, releases);
      return [
        { item: { kind: 'issue', key: c.key, title: c.title, ...of, standing }, score: c.score },
      ];
    }
    const s = feedbackById.get(c.ref);
    if (c.type !== 'feedback' || !s) return [];
    const standing = feedbackStanding(s, part, releases);
    return [
      { item: { kind: 'feedback', key: s.key, title: s.title, ...of, standing }, score: c.score },
    ];
  });
  return { found, total };
}

/**
 * Every project's matches merged by the door's fused score, each project's in its own order, at most
 * `HOME_FIND_LIMIT`: no order of the home's own.
 */
export function rankFound(found: readonly HomeFound[]): HomeFoundItem[] {
  return [...found]
    .sort((a, b) => b.score - a.score)
    .slice(0, HOME_FIND_LIMIT)
    .map((f) => f.item);
}
