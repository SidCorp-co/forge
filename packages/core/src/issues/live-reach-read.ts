import { liveReachOfIssue } from './ports.js';

/** Whether one merged issue's work is on production, from the releases Forge recorded; `null` where there is none to give. */
export async function liveReachForIssue(issue: {
  id: string;
  projectId: string;
  status: string;
  mergedAt: Date | string | null;
  mergedCommitSha: string | null;
}): Promise<object | null> {
  if (issue.mergedAt == null) return null;
  return liveReachOfIssue(issue);
}
