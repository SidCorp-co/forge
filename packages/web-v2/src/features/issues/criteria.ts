// ISS-55 — an issue's criteria as rows (`GET /api/issues/:id/criteria`), each with its latest
// verdict, folded to the criterion standing whose badge reads the same on every screen.

import type { StorefrontDraftVerdictView } from "@forge/contracts/verdict-identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { issueDetailApi } from "./detail-api";
import { issueKeySegment } from "./derive";
import type { IssueRow } from "./types";

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

/** `issueId` is the uuid, or the display key with the `projectId` it is scoped by. */
export function useCriteria(issueId: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["issue", issueKeySegment(issueId, projectId), "criteria"],
    queryFn: () =>
      apiClient<{ criteria: CriterionRow[] }>(
        `/issues/${issueId}/criteria${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      ),
    enabled: !!issueId,
  });
}

/** The identity a person's verdict names: the whole sha of the commit the judged work runs at. */
export interface VerdictCommit {
  sha: string;
  /** `live`: the live deployment carries the issue's work. `merged`: where it landed, not yet live. */
  source: "live" | "merged";
}

const WHOLE_SHA = /^[0-9a-f]{40}$/i;

export const isWholeSha = (sha: string) => WHOLE_SHA.test(sha.trim());

/**
 * What a verdict on this issue is judged against by default: the commit the live deployment runs
 * when core reads the issue's work on it, else the commit it merged as; null where it has neither.
 */
export function defaultVerdictCommit(issue: Pick<IssueRow, "liveReach" | "mergedCommitSha">): VerdictCommit | null {
  const reach = issue.liveReach;
  if (reach && reach.state === "none_waiting" && isWholeSha(reach.liveSha)) return { sha: reach.liveSha, source: "live" };
  if (issue.mergedCommitSha && isWholeSha(issue.mergedCommitSha)) return { sha: issue.mergedCommitSha, source: "merged" };
  return null;
}

export type PersonVerdict = "pass" | "fail" | "short";

export interface VerdictDraft {
  criterion: number;
  verdict: PersonVerdict;
  sha: string;
  note: string;
  screenshot: File | null;
}

/**
 * Records a person's verdict on one criterion: the screenshot, when one is given, is attached to the
 * issue first and cited by its name, so the verdict's evidence resolves to a file the tracker holds;
 * the note is the verdict's reason. Core refuses a wrong verdict by name and writes nothing.
 */
export function useRecordVerdict(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (d: VerdictDraft) => {
      const evidence = d.screenshot ? [(await issueDetailApi.uploadAttachment(issueId, d.screenshot)).name] : [];
      return apiClient<{ verdictId: string }>(`/issues/${issueId}/verdicts`, {
        method: "POST",
        body: JSON.stringify({
          criterion: d.criterion,
          verdict: d.verdict,
          reason: d.note.trim() || null,
          identity: { kind: "commit", sha: d.sha.trim() },
          evidence,
        }),
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
      qc.invalidateQueries({ queryKey: ["issues", "standing"] });
    },
  });
}

/**
 * Ties the issue to business criteria of its requirement (`POST /issues/:id/criteria/traces`): core
 * appends one criterion per code, worded as the BC, and takes it on a closed issue too.
 */
export function useTraceCriteria(issueId: string, projectId: string, requirementKey: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (codes: string[]) =>
      apiClient<{ criteria: CriterionRow[] }>(`/issues/${issueId}/criteria/traces`, { method: "POST", body: JSON.stringify({ codes }) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
      qc.invalidateQueries({ queryKey: ["issues", "standing"] });
      if (requirementKey) qc.invalidateQueries({ queryKey: ["requirement", projectId, requirementKey] });
    },
  });
}
