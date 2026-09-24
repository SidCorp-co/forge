import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { heldIssuePrefixes } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import {
  evidenceFor,
  issueRefPattern,
  type LiveReading,
  namedIssueSeqs,
} from '../projects/live-reach.js';
import { liveReadingForRow, projectReleaseRows } from '../projects/live-reading.js';
import { ageSeconds } from './pulse-folds.js';
import type {
  PulseCapped,
  PulseLiveGap,
  PulseNotOnLiveIdentity,
  PulseThresholds,
} from './pulse-types.js';

export interface PulseLive {
  notOnLive: PulseCapped<PulseNotOnLiveIdentity>;
  liveUnmeasured: PulseCapped<PulseLiveGap>;
}

type MeasuredReading = Extract<LiveReading, { kind: 'measured' }>;

/** The closed issues of one project that a measured reading places as not on its live branch. */
async function closedNotOnLive(
  project: { id: string; slug: string; issuePrefix: string | null },
  reading: MeasuredReading,
  now: Date,
): Promise<PulseNotOnLiveIdentity[]> {
  if (reading.commits.length === 0) return [];
  const pattern = issueRefPattern(await heldIssuePrefixes(project.id));
  const seqs = new Set<number>();
  for (const c of reading.commits) for (const s of namedIssueSeqs(c.message, pattern)) seqs.add(s);
  const shas = reading.commits.map((c) => c.sha);
  const match =
    seqs.size > 0
      ? or(inArray(issues.mergedCommitSha, shas), inArray(issues.issSeq, [...seqs]))
      : inArray(issues.mergedCommitSha, shas);
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
        match,
      ),
    );
  const out: PulseNotOnLiveIdentity[] = [];
  for (const r of rows) {
    const evidence = evidenceFor(r, reading.commits, pattern);
    if (evidence.length === 0) continue;
    out.push({
      documentId: r.id,
      issueRef: formatIssueRef(project.issuePrefix, r.issSeq),
      title: r.title,
      status: r.status,
      projectSlug: project.slug,
      ageSeconds: ageSeconds(r.mergedAt, now) ?? 0,
      liveBranch: reading.liveBranch,
      evidence,
    });
  }
  return out;
}

/**
 * Closed issues whose work a reading places off the live branch, and the `promote` projects no
 * reading could be taken for — the second list is what keeps the first from reading as a zero.
 */
export async function readPulseLive(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<PulseLive> {
  const releaseRows = (await projectReleaseRows(projectIds)).filter(
    (r) => r.releaseModel === 'promote',
  );
  if (releaseRows.length === 0) {
    return { notOnLive: { total: 0, shown: [] }, liveUnmeasured: { total: 0, shown: [] } };
  }
  const named = await db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      issuePrefix: projects.issuePrefix,
    })
    .from(projects)
    .where(
      inArray(
        projects.id,
        releaseRows.map((r) => r.id),
      ),
    );
  const byId = new Map(named.map((p) => [p.id, p]));

  const readings = await Promise.all(
    releaseRows.map(async (row) => ({ row, reading: await liveReadingForRow(row) })),
  );
  const notOnLive: PulseNotOnLiveIdentity[] = [];
  const gaps: PulseLiveGap[] = [];
  for (const { row, reading } of readings) {
    const project = byId.get(row.id);
    if (!reading || !project) continue;
    if (reading.kind === 'measured') {
      notOnLive.push(...(await closedNotOnLive(project, reading, now)));
      continue;
    }
    gaps.push({
      id: project.id,
      slug: project.slug,
      name: project.name,
      baseBranch: reading.baseBranch,
      liveBranch: reading.liveBranch,
      reason: reading.reason,
    });
  }
  notOnLive.sort((a, b) => b.ageSeconds - a.ageSeconds);
  gaps.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    notOnLive: { total: notOnLive.length, shown: notOnLive.slice(0, thresholds.identityCap) },
    liveUnmeasured: { total: gaps.length, shown: gaps.slice(0, thresholds.identityCap) },
  };
}
