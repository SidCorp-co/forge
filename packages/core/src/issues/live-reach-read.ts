import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
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
  const prefixes = await heldIssuePrefixes(issue.projectId);
  return liveReachOf(issue, reading, issueRefPattern(prefixes));
}
