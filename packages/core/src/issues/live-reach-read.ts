import { heldIssuePrefixes } from './issue-prefix-read.js';
import { liveReachOfIssue } from './ports.js';

/** One merged issue's place against the branch production deploys from; `null` where there is none to give. */
export async function liveReachForIssue(issue: {
  projectId: string;
  issSeq: number;
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}): Promise<object | null> {
  if (issue.mergedAt == null) return null;
  return liveReachOfIssue(issue, await heldIssuePrefixes(issue.projectId));
}
