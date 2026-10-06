// ISS-55 — an issue's criteria as rows (`GET /api/issues/:id/criteria`), each with its latest
// verdict, folded to the criterion standing whose badge reads the same on every screen.

import type { StorefrontDraftVerdictView } from "@forge/contracts/verdict-identity";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";

export interface CriterionVerdict extends StorefrontDraftVerdictView {
  verdict: "pass" | "short" | "fail" | "skipped";
  reason: string | null;
  identityKind: "commit" | "runtime" | "design" | "contract" | "storefront_draft" | "commit_unresolved" | null;
  commitSha: string | null;
  runtimeRef: string | null;
  designFlow: string | null;
  designWorkflowId: string | null;
  designRevision: number | null;
  contractRef: string | null;
  contractVersion: string | null;
  evidence: string[];
  authorAgency: "human" | "agent";
  backfilled: boolean;
  createdAt: string;
}

export interface CriterionRow {
  id: string;
  n: number;
  statement: string;
  position: number;
  requirementCriterionId: string | null;
  latest: CriterionVerdict | null;
}

export function useCriteria(issueId: string | undefined) {
  return useQuery({
    queryKey: ["issue", issueId, "criteria"],
    queryFn: () => apiClient<{ criteria: CriterionRow[] }>(`/issues/${issueId}/criteria`),
    enabled: !!issueId,
  });
}
