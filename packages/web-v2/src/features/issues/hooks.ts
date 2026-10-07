"use client";


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef } from "react";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { type CreateIssueInput, type PatchIssueInput, type CarriedDecisionBody, type CreateReleaseBatchResult, type LabelAttach, type MarkMergedBody, issuesApi, modulesApi, releaseBatchApi } from "./api";
import { registryApi } from "./registry-api";
import type {
  IssueLabel,
  IssuePriority,
  CreatedIssue,
  IssueSearchOpts,
  IssueStatus,
  WaitingCause,
} from "./types";

/**
 * Create an issue in `projectId`. On success invalidates `['issues']` so the new
 * row appears live, then hands it back — the dialog navigates to its detail page
 * and owns the success/failure path, so no toast here (mirrors `useCreateProject`).
 */
export function useCreateIssue(projectId: string) {
  const qc = useQueryClient();
  return useMutation<CreatedIssue, unknown, CreateIssueInput>({
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
    placeholderData: (prev) => prev,
  });
}

/** Per-issue cost rollup. Keyed `['issue', id, 'cost']` — lazy + cached; `projectId` lets a display-key `id` (ISS-1160) resolve. */
export function useIssueCost(id: string | undefined, enabled = true, projectId?: string) {
  return useQuery({
    queryKey: ["issue", id, "cost"],
    queryFn: () => issuesApi.costSummary(id as string, projectId),
    enabled: !!id && enabled,
    staleTime: 60_000,
  });
}

/** Per-issue dependency edges. Keyed `['issue', id, 'dependencies']` — lazy, same ISS-1160 scoping. */
export function useIssueDeps(id: string | undefined, enabled = true, projectId?: string) {
  return useQuery({
    queryKey: ["issue", id, "dependencies"],
    queryFn: () => issuesApi.dependencies(id as string, projectId),
    enabled: !!id && enabled,
    staleTime: 30_000,
  });
}

/** Project members (creator filter options). Keyed `['project', projectId, 'members']`. */
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

/**
 * The project's module taxonomy — the `kind='module'` half of `useProjectLabels`.
 *
 * Derived from the same query rather than a second request: core has no `?kind=` filter and no
 * `/modules` route, so one labels fetch serves the Labels tab, the label filter, the module filter
 * and the picker off one cache entry.
 */
/**
 * ISS-949 — the module rollup behind the Modules view. Keyed
 * `['project', projectId, 'modules', 'rollup', activeWithinDays]`.
 */
export function useModuleRollup(projectId: string | undefined, activeWithinDays?: number) {
  return useQuery({
    queryKey: ["project", projectId, "modules", "rollup", activeWithinDays ?? null],
    queryFn: () => modulesApi.rollup(projectId as string, activeWithinDays),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useProjectModules(projectId: string | undefined) {
  const q = useProjectLabels(projectId);
  const modules = useMemo(
    () => (q.data ?? []).filter((l) => l.kind === "module"),
    [q.data],
  );
  return { ...q, data: q.data ? modules : undefined, modules };
}

/**
 * The `labels` body for a module write, built from the issue's CURRENT labels.
 *
 * `PATCH /api/issues/:id` REPLACES the whole set, so every plain label the issue already carries
 * has to travel with the modules; a payload of modules alone deletes them, and the server cannot
 * tell that from a deliberate clear.
 */
export function buildModuleLabelWrite(
  current: IssueLabel[],
  moduleIds: string[],
  primaryId: string | null,
): LabelAttach[] {
  const kept: LabelAttach[] = current.filter((l) => l.kind !== "module").map((l) => l.id);
  const modules: LabelAttach[] = moduleIds.map((id) =>
    id === primaryId ? { labelId: id, isPrimary: true } : id,
  );
  return [...kept, ...modules];
}

/** Replace an issue's module attributions, preserving its plain labels. */
export function useSetIssueModules(issueId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: {
      current: IssueLabel[];
      moduleIds: string[];
      primaryId: string | null;
    }) =>
      issuesApi.setLabels(
        issueId as string,
        buildModuleLabelWrite(args.current, args.moduleIds, args.primaryId),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
      qc.invalidateQueries({ queryKey: ["issues"] });
      toast({ title: "Modules updated", tone: "success" });
    },
    onError: (err) =>
      toast({
        title: "Couldn't update modules",
        description: formatApiError(err),
        tone: "error",
      }),
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

/**
 * A description write, which differs from `usePatchIssue` in the one way that
 * matters on the detail screen: it invalidates `['issue', id]`, so the saved
 * body comes back rendered without a reload.
 */
export function useSaveDescription(id: string) {
  const qc = useQueryClient();
  const mut = useIssueMutation(
    (args: { id: string; body: PatchIssueInput }) => issuesApi.patch(args.id, args.body),
    { successMessage: "Description saved" },
  );
  return {
    ...mut,
    mutate: (args: { id: string; body: PatchIssueInput }, options?: { onSuccess?: () => void }) =>
      mut.mutate(args, {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["issue", id] });
          qc.invalidateQueries({ queryKey: ["activities", id] });
          options?.onSuccess?.();
        },
      }),
  };
}

type TransitionArgs = {
  id: string;
  toStatus: IssueStatus;
  reason?: string;
  waitingKind?: WaitingCause;
  voidQuestions?: string;
};

/**
 * ISS-1257 — the ids a terminal move was refused over, when it was refused because
 * the issue still holds open questions; null for every other failure.
 */
export function openQuestionIdsOf(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== "OPEN_QUESTIONS") return null;
  const ids = (err.details as { openQuestionIds?: unknown } | undefined)?.openQuestionIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

export function useTransitionIssue() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const mut = useMutation({
    mutationFn: (args: TransitionArgs) =>
      issuesApi.transition(args.id, args.toStatus, {
        reason: args.reason,
        waitingKind: args.waitingKind,
        voidQuestions: args.voidQuestions,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issues"] });
    },
  });
  return {
    ...mut,
    mutate: (
      args: TransitionArgs,
      options?: { onSuccess?: () => void; onOpenQuestions?: (ids: string[]) => void },
    ) =>
      mut.mutate(args, {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: ["issue", args.id] });
          qc.invalidateQueries({ queryKey: ["activities", args.id] });
          qc.invalidateQueries({ queryKey: ["questions", args.id] });
          options?.onSuccess?.();
        },
        onError: (err) => {
          const ids = openQuestionIdsOf(err);
          if (ids && options?.onOpenQuestions) {
            options.onOpenQuestions(ids);
            return;
          }
          toast({ title: "Update failed", description: formatApiError(err), tone: "error" });
        },
      }),
  };
}

/**
 * ISS-791 — the shipped-work claim for an issue finished by hand, outside the pipeline.
 *
 * `merged_at` is what lets an issue close at all: `closed` means the work shipped (ISS-1108) and a
 * close on an issue without it is refused by name. It releases no `blocks` dependent — those are
 * held by the issue's STATUS (ISS-1100). Both directions refresh the single-issue and activity
 * caches, because the server writes an audit comment on each call.
 */
export function useMergeMarker(issueId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["issue", issueId] });
    qc.invalidateQueries({ queryKey: ["activities", issueId] });
    qc.invalidateQueries({ queryKey: ["issues"] });
  };
  // ISS-1327 — the answer says whether this call moved the row; a toast that ignores it tells a
  // person their landing was recorded when the mark that stood was kept.
  const mark = useMutation({
    mutationFn: (args: MarkMergedBody) => issuesApi.markMerged(issueId, args),
    onSuccess: (answer) => {
      refresh();
      if (answer.action === "already_merged") {
        toast({
          title: "Already marked merged — nothing changed",
          description: "The mark that stands was kept. To change it, press Unmark, then Mark merged again.",
          tone: "info",
        });
      } else {
        toast({ title: "Marked merged", tone: "success" });
      }
    },
  });
  const unmark = useIssueMutation(
    (args: { note?: string } = {}) => issuesApi.unmarkMerged(issueId, args),
    { successMessage: "Merge mark removed" },
  );
  return {
    isPending: mark.isPending || unmark.isPending,
    /** Refused marks go to `onError` so the form that sent them can keep what was typed. */
    mark: (args: MarkMergedBody, options: { onSuccess?: () => void; onError?: (err: unknown) => void } = {}) =>
      mark.mutate(args, { onSuccess: () => options.onSuccess?.(), onError: (err) => options.onError?.(err) }),
    unmark: () => unmark.mutate({}, { onSuccess: refresh }),
  };
}

export function useRunPipelineStep() {
  return useIssueMutation((args: { id: string }) =>
    issuesApi.runPipelineStep(args.id), { successMessage: "Pipeline step queued" });
}


/** A single field to apply across many issues. */
export type BulkUpdate =
  | { kind: "status"; toStatus: IssueStatus }
  | { kind: "priority"; priority: IssuePriority };

/**
 * ISS-764 — create a batch release for a project. On success invalidates
 * `['issues']` + `['pipeline-runs']` so claimed issues update immediately.
 * On failure preserves the selection (does NOT clear `onCleared`) so the user
 * can retry after fixing the issue.
 */
/** What is waiting at the release gate, and when the next cut fires. */
export function useReleaseRoster(projectId: string | undefined) {
  return useQuery({
    queryKey: ["release-roster", projectId],
    queryFn: () => releaseBatchApi.roster(projectId as string),
    enabled: !!projectId,
  });
}

type BatchReleaseVars = { issueIds: string[]; carried?: CarriedDecisionBody[] };

/**
 * `showsRefusal` answers, when a refusal lands, whether the caller is showing it itself. One release
 * at a time: a press while one is on the wire is dropped, held by a ref because `isPending` reaches
 * the button only after a render, which a double click beats (ISS-1381 r4).
 */
export function useBatchRelease(projectId: string, { showsRefusal }: { showsRefusal?: () => boolean } = {}) {
  const mutation = useBatchReleaseMutation(projectId, showsRefusal);
  const inFlight = useRef(false);
  const { mutate: send } = mutation;
  const mutate = useCallback(
    (vars: BatchReleaseVars, options?: Parameters<typeof send>[1]) => {
      if (inFlight.current) return;
      inFlight.current = true;
      send(vars, {
        ...options,
        onSettled: (...args) => {
          inFlight.current = false;
          options?.onSettled?.(...args);
        },
      });
    },
    [send],
  );
  return { ...mutation, mutate };
}

function useBatchReleaseMutation(projectId: string, showsRefusal: (() => boolean) | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation<
    CreateReleaseBatchResult,
    unknown,
    BatchReleaseVars
  >({
    mutationFn: ({ issueIds, carried }) => releaseBatchApi.create(projectId, issueIds, carried),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["issues"] });
      qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      qc.invalidateQueries({ queryKey: ["release-roster"] });
      const said = [
        ...(result.carried?.kind === "read" ? [`It promotes ${result.carried.cut.slice(0, 12)}.`] : []),
        ...(result.verification === "unverified"
          ? [
              "This project declares no verify probe, so nothing will read the deployment: the release will close unverified, and each issue it closes will say so.",
            ]
          : []),
        ...result.warnings.map((w) => w.message),
      ];
      toast({
        title: `Batch release started — ${result.issueIds.length} issue${result.issueIds.length === 1 ? "" : "s"}`,
        ...(said.length > 0 ? { description: said.join(" ") } : {}),
        tone: "success",
      });
    },
    onError: (err) => {
      if (showsRefusal?.()) return;
      toast({
        title: "Batch release failed",
        description: formatApiError(err),
        tone: "error",
      });
    },
  });
}

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

/**
 * The per-rung status exits, read once per session from core's pipeline
 * registry. `isPending` and `isError` are what the three status surfaces
 * render instead of a menu — an absent map is never widened back into the
 * whole enum.
 */
export function useStatusExits() {
  const q = useQuery({
    queryKey: ["pipeline", "registry"],
    queryFn: () => registryApi.get(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return {
    exits: q.data?.statusExits,
    isPending: q.isPending,
    isError: q.isError || (!q.isPending && q.data?.statusExits === undefined),
  };
}
