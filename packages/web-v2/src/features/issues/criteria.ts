// ISS-55 — an issue's criteria as rows (`GET /api/issues/:id/criteria`), each with its latest
// verdict, folded to the criterion standing whose badge reads the same on every screen, and beside
// them the retired rows with every verdict each earned (ISS-489).

import { safeAttachmentName } from "@forge/contracts/attachments";
import type { JudgedBuild, StorefrontDraftVerdictView } from "@forge/contracts/verdict-identity";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { issueDetailApi } from "./detail-api";
import { issueKeySegment } from "./derive";

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

/** A criterion a reword, a removal or a re-tie retired, with every verdict on it, newest first; none counts. */
export interface RetiredCriterionRow {
  id: string;
  n: number;
  statement: string;
  requirementCriterionId: string | null;
  retiredAt: string;
  verdicts: CriterionVerdict[];
}

/** `issueId` is the uuid, or the display key with the `projectId` it is scoped by. */
export function useCriteria(issueId: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["issue", issueKeySegment(issueId, projectId), "criteria"],
    queryFn: () =>
      apiClient<{ criteria: CriterionRow[]; retired: RetiredCriterionRow[] }>(
        `/issues/${issueId}/criteria${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
      ),
    enabled: !!issueId,
  });
}

const WHOLE_SHA = /^[0-9a-f]{40}$/i;

export const isWholeSha = (sha: string) => WHOLE_SHA.test(sha.trim());

/**
 * The build a verdict on this issue is judged at by default, as core reads it
 * (`GET /issues/:id/judged-build`): the commit production serves where it carries the issue's work,
 * else the build that shipped it, else its merge commit, with how core knows. Read when the Judge
 * opens, since it may ask the live deployment and the repository.
 */
export function useJudgedBuild(issueId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["issue", issueId, "judged-build"],
    queryFn: () => apiClient<JudgedBuild>(`/issues/${issueId}/judged-build`),
    enabled,
    staleTime: 60_000,
  });
}

/** `short` counts as a pass; `skipped` is "could not judge", which needs a reason and never does. */
export type PersonVerdict = "pass" | "short" | "fail" | "skipped";

/** What a verdict cites: nothing, a file the issue already holds, or a new one uploaded as `as`. */
export type VerdictEvidence = { kind: "none" } | { kind: "attached"; name: string } | { kind: "upload"; file: File; as: string };

export interface VerdictDraft {
  criterion: number;
  verdict: PersonVerdict;
  /** Blank only on `skipped`, which may name no build. */
  sha: string;
  note: string;
  evidence: VerdictEvidence;
}

/** The name an upload is stored under: its own, or the first `-n` free beside the issue's files. */
export function freeAttachmentName(name: string, taken: readonly string[]): string {
  const safe = safeAttachmentName(name);
  const held = new Set(taken);
  if (!held.has(safe)) return safe;
  const dot = safe.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [safe.slice(0, dot), safe.slice(dot)] : [safe, ""];
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!held.has(candidate)) return candidate;
  }
}

async function evidenceNames(issueId: string, evidence: VerdictEvidence): Promise<string[]> {
  if (evidence.kind === "none") return [];
  if (evidence.kind === "attached") return [evidence.name];
  const file = evidence.file.name === evidence.as ? evidence.file : new File([evidence.file], evidence.as, { type: evidence.file.type });
  return [(await issueDetailApi.uploadAttachment(issueId, file)).name];
}

/**
 * Records a person's verdict on one criterion: a new screenshot is attached to the issue first and
 * cited by the name core kept, an attached file is cited as it is, so the verdict's evidence resolves
 * to a file the tracker holds; the note is the verdict's reason. Core refuses a wrong verdict by name
 * and writes nothing.
 */
export function useRecordVerdict(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (d: VerdictDraft) => {
      const evidence = await evidenceNames(issueId, d.evidence);
      const sha = d.sha.trim();
      return apiClient<{ verdictId: string }>(`/issues/${issueId}/verdicts`, {
        method: "POST",
        body: JSON.stringify({
          criterion: d.criterion,
          verdict: d.verdict,
          reason: d.note.trim() || null,
          identity: sha ? { kind: "commit", sha } : null,
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
