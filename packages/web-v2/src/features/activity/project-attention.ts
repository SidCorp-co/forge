// Whether a project needs attention (ISS-1072): a decision waits on the reader, or an issue reads
// stuck in the Issues list's own grouping. The Projects page reads its Attention through this one
// reading, never a rule of its own over parked statuses, so the two never disagree.

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { useQueries } from "@tanstack/react-query";
import { issueStandingQuery } from "@/features/issues";
import { needsYouDecisionsQuery } from "@/features/needs-you";

export function needsAttention(read: { decisions: { total: number }; issues: readonly Pick<IssueStandingRow, "standing">[] }): boolean {
  return read.decisions.total > 0 || read.issues.some((r) => r.standing.attentionGroup === "stuck");
}

/**
 * Each project's attention by {@link needsAttention}, from the Issues list's open standing and the
 * decisions waiting on the reader. A project not yet read is absent, never read as calm or as needing
 * attention.
 */
export function useProjectsAttention(projectIds: readonly string[]): ReadonlyMap<string, boolean> {
  const standing = useQueries({ queries: projectIds.map((id) => issueStandingQuery(id, "open")) });
  const decisions = useQueries({ queries: projectIds.map((id) => needsYouDecisionsQuery(id)) });
  const read = new Map<string, boolean>();
  projectIds.forEach((id, i) => {
    const issues = standing[i]?.data;
    const owed = decisions[i]?.data;
    if (!issues || !owed) return;
    read.set(id, needsAttention({ decisions: owed, issues: issues.issues }));
  });
  return read;
}
