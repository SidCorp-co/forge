import { type Said, say, sayEn, verbatim } from '@forge/contracts/said';
import { and, count, eq, gt, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, projects } from '../db/schema.js';
import { heldIssuePrefixes } from '../issues/issue-prefix-read.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import {
  evidenceFor,
  issueRefPattern,
  issueWorkRecordsAt,
  type LiveReading,
  liveReadingForRow,
  projectReleaseRows,
  type ReadingOwnership,
  readingOwnership,
  unclaimedShas,
} from '../projects/index.js';
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

type MeasuredReading = Extract<LiveReading, { kind: 'measured' }>;

/** Every waiting commit's issues, with the project's work records the reading needs read once. */
async function ownershipOf(projectId: string, reading: MeasuredReading): Promise<ReadingOwnership> {
  const pattern = issueRefPattern(await heldIssuePrefixes(projectId));
  const unclaimed = unclaimedShas(reading.commits, pattern, reading.baseBranch);
  const records = await issueWorkRecordsAt(projectId, unclaimed);
  return readingOwnership(reading.commits, pattern, reading, records);
}

async function closedNotOnLive(
  project: { id: string; slug: string; issuePrefix: string | null },
  reading: MeasuredReading,
  ownership: ReadingOwnership,
  now: Date,
): Promise<PulseNotOnLiveIdentity[]> {
  if (reading.commits.length === 0) return [];
  const seqs = new Set<number>();
  for (const owned of ownership.owners.values()) {
    for (const s of owned.keys()) seqs.add(s);
  }
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
    const evidence = evidenceFor(r, reading, ownership);
    if (evidence.length === 0) continue;
    out.push({
      documentId: r.id,
      issueRef: formatIssueRef(project.issuePrefix, r.issSeq),
      title: r.title,
      status: r.status,
      projectSlug: project.slug,
      ageSeconds: ageSeconds(r.mergedAt, now) ?? 0,
      deploysFrom: reading.deploysFrom,
      evidence,
    });
  }
  return out;
}

/**
 * Why a measured reading still leaves closed issues of this project unplaced, or null where it
 * places every one: a list cut short, issues that merged after the reading started, or waiting
 * commits no source gives to any issue.
 */
async function measuredGap(
  projectId: string,
  reading: MeasuredReading,
  placed: readonly string[],
  ownerless: number,
): Promise<Said | null> {
  const reasons: Said[] = [];
  if (!reading.complete) {
    reasons.push(
      say('pulse.gap.cut', {
        base: reading.baseBranch,
        ahead: reading.aheadBy,
        live: reading.deploysFrom,
        listed: reading.commits.length,
      }),
    );
  }
  const [late] = await db
    .select({ n: count() })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, 'closed'),
        gt(issues.mergedAt, reading.startedAt),
        ...(placed.length > 0 ? [notInArray(issues.id, [...placed])] : []),
      ),
    );
  const n = Number(late?.n ?? 0);
  if (n > 0) {
    const at = reading.startedAt.toISOString();
    reasons.push(n === 1 ? say('pulse.gap.lateOne', { at }) : say('pulse.gap.lateMany', { n, at }));
  }
  if (ownerless > 0) {
    const base = reading.baseBranch;
    reasons.push(
      ownerless === 1
        ? say('pulse.gap.ownerlessOne', { base })
        : say('pulse.gap.ownerlessMany', { n: ownerless, base }),
    );
  }
  const [first, ...more] = reasons;
  if (!first) return null;
  return more.length === 0 ? first : say('pulse.gap.all', { parts: reasons });
}

/**
 * Closed issues whose work a reading places off the live branch, and the `promote` projects whose
 * reading could not place every closed issue — the second list keeps the first from reading as a zero.
 */
export async function readPulseLive(
  projectIds: string[],
  thresholds: PulseThresholds,
  now: Date,
): Promise<PulseLive> {
  const releaseRows = (await projectReleaseRows(projectIds)).filter((r) => r.deploysFrom !== null);
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
    // a reading that could not compare says why as the reading wrote it (`projects/live-reading.ts`)
    let reason: Said | null = reading.kind === 'measured' ? null : verbatim(reading.reason);
    if (reading.kind === 'measured') {
      const ownership = await ownershipOf(project.id, reading);
      const placed = await closedNotOnLive(project, reading, ownership, now);
      notOnLive.push(...placed);
      reason = await measuredGap(
        project.id,
        reading,
        placed.map((i) => i.documentId),
        ownership.ownerless.length,
      );
    }
    if (reason === null) continue;
    gaps.push({
      id: project.id,
      slug: project.slug,
      name: project.name,
      baseBranch: reading.baseBranch,
      deploysFrom: reading.deploysFrom,
      reason: sayEn(reason),
      says: { reason },
    });
  }
  notOnLive.sort((a, b) => b.ageSeconds - a.ageSeconds);
  gaps.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    notOnLive: { total: notOnLive.length, shown: notOnLive.slice(0, thresholds.identityCap) },
    liveUnmeasured: { total: gaps.length, shown: gaps.slice(0, thresholds.identityCap) },
  };
}
