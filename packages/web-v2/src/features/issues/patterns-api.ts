import type { IssuePatternResponse, IssuePatterns, PatternDecision } from "@forge/contracts/patterns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { issueKeySegment } from "./derive";

// An issue's patterns (REQ-36 BC-2; Issue lifecycle r14 `design-check`): what it names, and the one
// review a new one waits on. Keyed under `['issue', id]`, which the event router invalidates, and
// read with the page's first reads (`use-issue-reads.ts`), the key moving to the uuid once known.

export const patternsApi = {
  /** `GET /api/issues/:id/patterns` — its patterns, the hold, and which the caller may decide. */
  list: (issueId: string, projectId?: string) =>
    apiClient<IssuePatterns>(
      `/issues/${issueId}/patterns${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    ),
  /** `POST /api/issues/:id/patterns/:patternId/decision` — approve or return a new pattern, with why. */
  decide: (issueId: string, patternId: string, decision: PatternDecision, reason: string) =>
    apiClient<IssuePatternResponse>(`/issues/${issueId}/patterns/${patternId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision, reason }),
    }),
};

export function useIssuePatterns(issueId: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["issue", issueKeySegment(issueId, projectId), "patterns"],
    queryFn: () => patternsApi.list(issueId as string, projectId),
    enabled: !!issueId,
  });
}

export function useDecidePattern(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { patternId: string; decision: PatternDecision; reason: string }) =>
      patternsApi.decide(issueId, args.patternId, args.decision, args.reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
      // a return posts its reason on the issue
      qc.invalidateQueries({ queryKey: ["comments", issueId] });
    },
  });
}
