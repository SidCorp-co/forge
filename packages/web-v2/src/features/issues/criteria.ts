// ISS-55 — an issue's criteria as rows (`GET /api/issues/:id/criteria`), each with its latest
// verdict, folded to the criterion standing whose badge reads the same on every screen.

import type { CriterionStanding } from "@forge/contracts/issue-vocabulary";
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

/** The one reading each state takes on every screen is contracts' `CRITERION_STANDINGS`. */
export type CriterionBadge = CriterionStanding;

/** `short` is a judged pass; a backfilled abbreviated commit reads Unresolved, whatever it said. */
export function criterionBadge(latest: CriterionVerdict | null): CriterionBadge {
  if (!latest) return "unjudged";
  if (latest.identityKind === "commit_unresolved") return "unresolved";
  if (latest.verdict === "pass" || latest.verdict === "short") return "pass";
  return latest.verdict;
}

/** What the verdict was judged against, as one phrase for the tooltip. */
export function identityPhrase(v: CriterionVerdict): string {
  switch (v.identityKind) {
    case "commit":
      return `commit ${v.commitSha?.slice(0, 12)}`;
    case "commit_unresolved":
      return `abbreviated commit ${v.commitSha} (backfilled, never resolved)`;
    case "runtime":
      return `runtime ${v.runtimeRef?.slice(0, 12)}`;
    case "design":
      return `design ${v.designFlow ?? v.designWorkflowId} rev ${v.designRevision}`;
    case "contract":
      return `contract ${v.contractRef}@${v.contractVersion}`;
    case "storefront_draft":
      return `storefront draft ${v.storefrontWorkflowId}@${v.storefrontDraftVersion?.slice(0, 12)} on ${v.storefrontEnvironment}${v.corroboration === "corroborated" ? "" : ` (${v.corroboration ?? "uncorroborated"}: ${v.corroborationNote})`}`;
    default:
      return "no identity";
  }
}

export function useCriteria(issueId: string | undefined) {
  return useQuery({
    queryKey: ["issue", issueId, "criteria"],
    queryFn: () => apiClient<{ criteria: CriterionRow[] }>(`/issues/${issueId}/criteria`),
    enabled: !!issueId,
  });
}
