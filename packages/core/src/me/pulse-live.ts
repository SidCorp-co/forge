import { say, sayEn } from '@forge/contracts/said';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { liveReachOfIssues } from '../pipeline/index.js';
import { readLandingBranches } from '../project-config/index.js';
import { ageSeconds } from './pulse-folds.js';
import type {
  PulseCapped,
  PulseLiveGap,
  PulseNotOnLiveIdentity,
  PulseThresholds,
} from './pulse-types.js';

interface PulseLive {
  notOnLive: PulseCapped<PulseNotOnLiveIdentity>;
  liveUnmeasured: PulseCapped<PulseLiveGap>;
}

interface PromoteProject {
  id: string;
  slug: string;
  name: string;
  issuePrefix: string | null;
  deploysFrom: string;
}

/**
 * One project's closed issues that a record places off production, and how many no record places:
 * read from the releases Forge recorded shipping (`pipeline/live-reach.ts`), never the branches.
 */
async function projectLive(
  project: PromoteProject,
  now: Date,
): Promise<{ notOnLive: PulseNotOnLiveIdentity[]; gap: PulseLiveGap | null }> {
  const rows = await db
    .select({
      id: issues.id,
      issSeq: issues.issSeq,
      title: issues.title,
      status: issues.status,
      mergedAt: issues.mergedAt,
      mergedCommitSha: issues.mergedCommitSha,
    })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, project.id),
        eq(issues.status, 'closed'),
        isNotNull(issues.mergedAt),
      ),
    );
  const reach = await liveReachOfIssues(project.id, rows, project.deploysFrom);
  const notOnLive: PulseNotOnLiveIdentity[] = [];
  let unrecorded = 0;
  let noRelease = false;
  for (const r of rows) {
    const at = reach.get(r.id);
    if (at?.state === 'unrecorded') {
      unrecorded += 1;
      noRelease ||= at.cause === 'no_release';
    }
    if (at?.state !== 'not_on_live') continue;
    notOnLive.push({
      documentId: r.id,
      issueRef: formatIssueRef(project.issuePrefix, r.issSeq),
      title: r.title,
      status: r.status,
      projectSlug: project.slug,
      ageSeconds: ageSeconds(r.mergedAt, now) ?? 0,
      deploysFrom: project.deploysFrom,
      commit: at.commit,
      why: at.why,
    });
  }
  if (unrecorded === 0) return { notOnLive, gap: null };
  const live = project.deploysFrom;
  const reason = noRelease
    ? say('pulse.gap.noRelease', { n: unrecorded, live })
    : unrecorded === 1
      ? say('pulse.gap.unrecordedOne', { live })
      : say('pulse.gap.unrecordedMany', { n: unrecorded, live });
  return {
    notOnLive,
    gap: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      deploysFrom: live,
      reason: sayEn(reason),
      says: { reason },
    },
  };
}

/**
 * Closed issues a release record places off production, and the `promote` projects holding closed
 * issues no record places either way: the second list keeps the first from reading as a zero.
 */
export async function readPulseLive(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<PulseLive> {
  const empty = { notOnLive: { total: 0, shown: [] }, liveUnmeasured: { total: 0, shown: [] } };
  if (projectIds.length === 0) return empty;
  const named = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      issuePrefix: projects.issuePrefix,
    })
    .from(projects)
    .where(inArray(projects.id, projectIds));
  const promote = (
    await Promise.all(
      named.map(async (p) => ({ ...p, deploysFrom: (await readLandingBranches(p.id)).promoted })),
    )
  ).filter((p): p is PromoteProject => p.deploysFrom !== null);
  if (promote.length === 0) return empty;

  const notOnLive: PulseNotOnLiveIdentity[] = [];
  const gaps: PulseLiveGap[] = [];
  for (const read of await Promise.all(promote.map((p) => projectLive(p, now)))) {
    notOnLive.push(...read.notOnLive);
    if (read.gap) gaps.push(read.gap);
  }
  notOnLive.sort((a, b) => b.ageSeconds - a.ageSeconds);
  gaps.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    notOnLive: { total: notOnLive.length, shown: notOnLive.slice(0, thresholds.identityCap) },
    liveUnmeasured: { total: gaps.length, shown: gaps.slice(0, thresholds.identityCap) },
  };
}
