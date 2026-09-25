import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { unclaimedShas } from '../projects/commit-owners.js';
import { issueWorkRecordsAt } from '../projects/issue-work-records.js';
import { issueRefPattern, type LiveReach, liveReachOf } from '../projects/live-reach.js';
import {
  type LiveReadingDeps,
  liveReadingForRow,
  releaseColumns,
} from '../projects/live-reading.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';

/** One merged issue's place against its project's live branch; `null` where there is none to give. */
export async function liveReachForIssue(
  issue: {
    projectId: string;
    issSeq: number;
    mergedAt: Date | string | null;
    mergedCommitSha: string | null;
  },
  deps?: LiveReadingDeps,
): Promise<LiveReach | null> {
  if (issue.mergedAt == null) return null;
  const [row] = await db
    .select(releaseColumns)
    .from(projects)
    .where(eq(projects.id, issue.projectId))
    .limit(1);
  if (!row) return null;
  const reading = await liveReadingForRow(row, deps);
  if (!reading) return null;
  const pattern = issueRefPattern(await heldIssuePrefixes(issue.projectId));
  const records =
    reading.kind === 'measured'
      ? await issueWorkRecordsAt(
          issue.projectId,
          unclaimedShas(reading.commits, pattern, reading.baseBranch),
        )
      : [];
  return liveReachOf(issue, reading, pattern, records);
}
