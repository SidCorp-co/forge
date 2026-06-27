"use client";

// web-v2 feature module: issues — React Query hooks (Part A list + shared).
//
// Query-key contract (ISS-293) — keys MUST match `lib/ws/event-router.ts`:
//   list   → ['issues','search', projectId, opts]   (issue.* events)
//   cost   → ['issue', id, 'cost']                  (lazy; no WS event)
//   deps   → ['issue', id, 'dependencies']          (dependencyChanged)
//   members→ ['project', projectId, 'members']
// Any other prefix → WS-driven invalidation silently no-ops.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { type CreateIssueInput, type PatchIssueInput, issuesApi } from "./api";
import type { IssueLabel, IssuePriority, IssueRow, IssueSearchOpts, IssueStatus } from "./types";

/**
 * Create an issue in `projectId`. On success invalidates `['issues']` so the
 * new row appears live in the list, then hands the created row back to the
 * caller (the dialog navigates to its detail page). No toast here — the dialog
 * owns the success/failure path (mirrors `useCreateProject`).
 */
export function useCreateIssue(projectId: string) {
  const qc = useQueryClient();
  return useMutation<IssueRow, unknown, CreateIssueInput>({
    mutationFn: (body) => issuesApi.create(projectId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issues"] });
    },
  });
}

/** Issues search list. Keyed `['issues','search', projectId, opts]`. */
export function useIssues(projectId: string | undefined, opts: IssueSearchOpts) {
  return useQuery({
    queryKey: ["issues", "search", projectId, opts],
    queryFn: () => issuesApi.search(projectId as string, opts),
    enabled: !!projectId,
    placeholderData: (prev) => prev, // keep rows visible across page/filter changes
  });
}

/** Per-issue cost rollup. Keyed `['issue', id, 'cost']` — lazy + cached. */
export function useIssueCost(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["issue", id, "cost"],
    queryFn: () => issuesApi.costSummary(id as string),
    enabled: !!id && enabled,
    staleTime: 60_000,
  });
}

/** Per-issue dependency edges. Keyed `['issue', id, 'dependencies']` — lazy. */
export function useIssueDeps(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["issue", id, "dependencies"],
    queryFn: () => issuesApi.dependencies(id as string),
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
}

/** Project members (assignee options). Keyed `['project', projectId, 'members']`. */
export function useProjectMembers(projectId: string | undefined) {
  return useQuery({
    queryKey: ["project", projectId, "members"],
    queryFn: () => issuesApi.members(projectId as string),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  });
}

/** Project labels (label filter options). Keyed `['project', projectId, 'labels']` (ISS-586). */
export function useProjectLabels(projectId: string | undefined) {
  return useQuery<IssueLabel[]>({
    queryKey: ["project", projectId, "labels"],
    queryFn: () => issuesApi.labels(projectId as string),
    enabled: !!projectId,
    staleTime: 5 * 60_000,
  });
}

/** Shared mutation factory: invalidate `['issues']` on success, toast on error
 *  (409 ILLEGAL_TRANSITION / 400 ASSIGNEE_NOT_MEMBER map to friendly copy). */
function useIssueMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { successMessage?: string } = {},
) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issues"] });
      if (opts.successMessage) toast({ title: opts.successMessage, tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Update failed", description: formatApiError(err), tone: "error" });
    },
  });
}

export function usePatchIssue() {
  return useIssueMutation((args: { id: string; body: PatchIssueInput }) =>
    issuesApi.patch(args.id, args.body),
  );
}

export function useTransitionIssue() {
  const qc = useQueryClient();
  const mut = useIssueMutation(
    (args: { id: string; toStatus: IssueStatus; reason?: string }) =>
      issuesApi.transition(args.id, args.toStatus, args.reason),
  );
  // Also refresh the single-issue + activity caches (detail view) on success.
  return {
    ...mut,
    mutate: (args: { id: string; toStatus: IssueStatus; reason?: string }) =>
      mut.mutate(args, {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["issue", args.id] });
          qc.invalidateQueries({ queryKey: ["activities", args.id] });
        },
      }),
  };
}

export function useRunPipelineStep() {
  return useIssueMutation((args: { id: string; stage?: string }) =>
    issuesApi.runPipelineStep(args.id, args.stage), { successMessage: "Pipeline step queued" });
}

// ─── Bulk update (ISS-463) ──────────────────────────────────────────────────

/** A single field to apply across many issues. */
export type BulkUpdate =
  | { kind: "status"; toStatus: IssueStatus }
  | { kind: "priority"; priority: IssuePriority };

/** Outcome tally of a bulk apply. `skipped` = the server rejected the change
 *  with 409 (invalid transition / no-op / stale) — surfaced, not failed. */
export interface BulkSummary {
  updated: number;
  skipped: number;
  failed: number;
}

/** Max concurrent requests per wave — a no-limit selection shouldn't open 100
 *  sockets at once. */
const BULK_CHUNK = 8;

/**
 * Apply ONE field change (status or priority) to many issues at once. Fans out
 * over the SAME endpoints the per-row kebab uses — status → transition (409 =
 * skipped), priority → patch — in bounded chunks via `Promise.allSettled`, then
 * tallies ONCE and invalidates `['issues']` (+ each touched `['issue', id]`)
 * ONCE, with a single summary toast. Deliberately NOT built on
 * `useIssueMutation` (which would fire N toasts + N invalidations). ISS-463.
 */
export function useBulkUpdateIssues() {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<BulkSummary, unknown, { ids: string[]; update: BulkUpdate }>({
    mutationFn: async ({ ids, update }) => {
      const summary: BulkSummary = { updated: 0, skipped: 0, failed: 0 };
      const apply = (id: string) =>
        update.kind === "status"
          ? issuesApi.transition(id, update.toStatus)
          : issuesApi.patch(id, { priority: update.priority });
      for (let i = 0; i < ids.length; i += BULK_CHUNK) {
        const results = await Promise.allSettled(ids.slice(i, i + BULK_CHUNK).map(apply));
        for (const r of results) {
          if (r.status === "fulfilled") summary.updated++;
          else if (r.reason instanceof ApiError && r.reason.status === 409) summary.skipped++;
          else summary.failed++;
        }
      }
      return summary;
    },
    onSuccess: (summary, { ids }) => {
      qc.invalidateQueries({ queryKey: ["issues"] });
      for (const id of ids) qc.invalidateQueries({ queryKey: ["issue", id] });
      const parts = [`${summary.updated} updated`];
      if (summary.skipped) parts.push(`${summary.skipped} skipped`);
      if (summary.failed) parts.push(`${summary.failed} failed`);
      toast({
        title: parts.join(" · "),
        tone: summary.failed > 0 ? "error" : "success",
      });
    },
    onError: (err) => {
      toast({ title: "Bulk update failed", description: formatApiError(err), tone: "error" });
    },
  });
}
