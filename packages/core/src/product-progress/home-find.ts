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
 * The project's issues and feedback items matching `q`, as a filter of the find door (ISS-1256): its
 * ranks, its key match and its glossary expansion. A home search spans projects, so a miss in one is
 * no gap of that project's.
 */
async function matching(projectId: string, q: string, reader: ProjectReader) {
  const { fused } = await runFind({
    projectId,
    projectIds: [projectId],
    query: { q, type: ['issue', 'feedback'], limit: HOME_FIND_LIMIT },
    reader,
    askedBy: 'person',
    recordsGap: false,
  });
  return fused.filter((c) => c.type === 'issue' || c.type === 'feedback');
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
): Promise<{ items: HomeFoundItem[]; total: number }> {
  const of = { projectSlug: project.slug, projectName: project.name };
  const found = await matching(project.id, q, reader);
  const feedbackById = new Map(part.allFeedback.map((s) => [s.id, s]));
  const items = found.flatMap((c): HomeFoundItem[] => {
    if (c.type === 'issue' && c.key) {
      const claimed = (c.native as IssueNative | undefined)?.releaseBatchRunId != null;
      const standing = issueStanding(c.key, c.status ?? '', claimed, part, releases);
      return [{ kind: 'issue', key: c.key, title: c.title, ...of, standing }];
    }
    const s = feedbackById.get(c.ref);
    if (c.type !== 'feedback' || !s) return [];
    return [
      {
        kind: 'feedback',
        key: s.key,
        title: s.title,
        ...of,
        standing: feedbackStanding(s, part, releases),
      },
    ];
  });
  return { items: items.slice(0, HOME_FIND_LIMIT), total: items.length };
}

/** Every project's matches, an exact key first, at most `HOME_FIND_LIMIT`. */
export function rankFound(q: string, found: readonly HomeFoundItem[]): HomeFoundItem[] {
  const exact = (f: HomeFoundItem) => (f.key.toLowerCase() === q.toLowerCase() ? 0 : 1);
  return [...found].sort((a, b) => exact(a) - exact(b)).slice(0, HOME_FIND_LIMIT);
}
