

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { type Refusal, refusalFact, refusalsOf } from "@/lib/api/refusals";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { useToastWrite } from "@/providers/toast-write";
import { issueKeys, issueQueries } from "./queries";
import { type CreateIssueInput, type PatchIssueInput, type CreateReleaseBatchResult, type LabelAttach, type MarkMergedBody, issuesApi, releaseBatchApi } from "./api";
import type { IssueStandingScope } from "@forge/contracts/issue-standing";
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
      void qc.invalidateQueries({ queryKey: issueKeys.all });
    },
  });
}

/** Issues search list. Keyed `['issues','search', projectId, opts]`. */
export function useIssues(projectId: string | undefined, opts: IssueSearchOpts) {
  return useQuery(issueQueries.search(projectId, opts));
}

/** Per-issue cost rollup. Keyed `['issue', id, 'cost']` — lazy + cached; `projectId` lets a display-key `id` (ISS-1160) resolve. */
/** Keyed under `['issues','standing']`, which the event router invalidates on every issue event. */
export function useIssueStanding(projectId: string | undefined, scope: IssueStandingScope) {
  return useQuery(issueQueries.standing(projectId, scope));
}

export function useIssueStandingOf(projectId: string | undefined, key: string | undefined) {
  return useQuery(issueQueries.standingOf(projectId, key));
}

export function useIssueCost(id: string | undefined, enabled = true, projectId?: string) {
  return useQuery(issueQueries.cost(id, enabled, projectId));
}

/** Per-issue dependency edges. Keyed `['issue', id, 'dependencies']` — lazy, same ISS-1160 scoping. */
export function useIssueDeps(id: string | undefined, enabled = true, projectId?: string) {
  return useQuery(issueQueries.deps(id, enabled, projectId));
}

/** Project members (creator filter options). Keyed `['project', projectId, 'members']`. */
export function useProjectMembers(projectId: string | undefined) {
  return useQuery(issueQueries.members(projectId));
}

/** Project labels (label filter options). Keyed `['project', projectId, 'labels']` (ISS-586). */
const projectLabelsQuery = issueQueries.labels;

export function useProjectLabels(projectId: string | undefined) {
  return useQuery(projectLabelsQuery(projectId));
}

/**
 * The project's module taxonomy — the `kind='module'` half of `useProjectLabels`.
 *
 * Derived from the same query rather than a second request: core has no `?kind=` filter and no
 * `/modules` route, so one labels fetch serves the Labels tab, the label filter, the module filter
 * and the picker off one cache entry.
 */
export function useProjectModules(projectId: string | undefined) {
  return useQuery({ ...projectLabelsQuery(projectId), select: (labels) => labels.filter((l) => l.kind === "module") });
}

/**
 * The `labels` body for a module write, built from the issue's CURRENT labels.
 *
 * `PATCH /api/issues/:id` REPLACES the whole set, so every plain label the issue already carries
 * has to travel with the modules; a payload of modules alone deletes them, and the server cannot
 * tell that from a deliberate clear.
 */
function buildModuleLabelWrite(
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
  const t = useCopy();
  return useIssueMutation(
    (args: { current: IssueLabel[]; moduleIds: string[]; primaryId: string | null }) =>
      issuesApi.setLabels(issueId as string, buildModuleLabelWrite(args.current, args.moduleIds, args.primaryId)),
    { success: t("issues.toast.modulesUpdated"), failure: t("issues.toast.modulesFailed"), touches: () => [["issue", issueId]] },
  );
}

/** The issue write every hook below shares: `['issues']` and the reads in `touches` are read again on success, a
 *  `success` line is toasted, and a refusal is toasted in core's words under `failure` (an update failure by default). */
function useIssueMutation<TArgs, TData>(
  fn: (args: TArgs) => Promise<TData>,
  opts: { success?: string; failure?: string; touches?: (args: TArgs) => readonly unknown[][] } = {},
) {
  const t = useCopy();
  return useToastWrite(fn, {
    touches: (args) => [issueKeys.all, ...(opts.touches?.(args) ?? [])],
    said: opts.success,
    failed: opts.failure ?? t("issues.toast.updateFailed"),
  });
}

export function usePatchIssue() {
  return useIssueMutation((args: { id: string; body: PatchIssueInput }) =>
    issuesApi.patch(args.id, args.body),
  );
}

/** A description write: unlike `usePatchIssue` it re-reads `['issue', id]`, so the saved body comes back rendered without a reload. */
export function useSaveDescription(id: string) {
  const t = useCopy();
  return useIssueMutation((args: { id: string; body: PatchIssueInput }) => issuesApi.patch(args.id, args.body), {
    success: t("issues.toast.descriptionSaved"),
    touches: () => [["issue", id], ["activities", id]],
  });
}

type TransitionArgs = {
  id: string;
  toStatus: IssueStatus;
  reason?: string;
  waitingKind?: WaitingCause;
  voidQuestions?: string;
  answers?: Record<string, string>;
};

/** The refusals a move answered because its checklist is not complete, or null for any other failure. */
function checklistRefusalsOf(err: unknown): Refusal[] | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== "CHECKLIST_INCOMPLETE" && err.code !== "CHECKLIST_ANSWER_INVALID") return null;
  return refusalsOf(err);
}

/**
 * ISS-1257 — the ids a terminal move was refused over, when it was refused because
 * the issue still holds open questions; null for every other failure.
 */
function openQuestionIdsOf(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== "OPEN_QUESTIONS") return null;
  const ids = refusalFact(err, "openQuestionIds");
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

export function useTransitionIssue() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  const mut = useMutation({
    mutationFn: (args: TransitionArgs) =>
      issuesApi.transition(args.id, args.toStatus, {
        reason: args.reason,
        waitingKind: args.waitingKind,
        voidQuestions: args.voidQuestions,
        answers: args.answers,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: issueKeys.all });
    },
  });
  return {
    ...mut,
    mutate: (
      args: TransitionArgs,
      options?: {
        onSuccess?: () => void;
        onOpenQuestions?: (ids: string[]) => void;
        onChecklist?: (refusals: Refusal[]) => void;
      },
    ) =>
      mut.mutate(args, {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: ["issue", args.id] });
          void qc.invalidateQueries({ queryKey: ["activities", args.id] });
          void qc.invalidateQueries({ queryKey: ["questions", args.id] });
          options?.onSuccess?.();
        },
        onError: (err) => {
          const ids = openQuestionIdsOf(err);
          if (ids && options?.onOpenQuestions) {
            options.onOpenQuestions(ids);
            return;
          }
          const gaps = checklistRefusalsOf(err);
          if (gaps && options?.onChecklist) {
            options.onChecklist(gaps);
            return;
          }
          toast({ title: t("issues.toast.updateFailed"), description: formatApiError(err), tone: "error" });
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
  const t = useCopy();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["issue", issueId] });
    void qc.invalidateQueries({ queryKey: ["activities", issueId] });
    void qc.invalidateQueries({ queryKey: issueKeys.all });
  };
  // ISS-1327 — the answer says whether this call moved the row; a toast that ignores it tells a
  // person their landing was recorded when the mark that stood was kept.
  const mark = useMutation({
    mutationFn: (args: MarkMergedBody) => issuesApi.markMerged(issueId, args),
    onSuccess: (answer) => {
      refresh();
      if (answer.action === "already_merged") {
        toast({
          title: t("issues.toast.alreadyMerged"),
          tone: "info",
        });
      } else {
        toast({ title: t("issues.toast.marked"), tone: "success" });
      }
    },
  });
  const unmark = useIssueMutation((args: { note?: string } = {}) => issuesApi.unmarkMerged(issueId, args), { success: t("issues.toast.unmarked") });
  return {
    isPending: mark.isPending || unmark.isPending,
    /** Refused marks go to `onError` so the form that sent them can keep what was typed. */
    mark: (args: MarkMergedBody, options: { onSuccess?: () => void; onError?: (err: unknown) => void } = {}) =>
      mark.mutate(args, { onSuccess: () => options.onSuccess?.(), onError: (err) => options.onError?.(err) }),
    unmark: () => unmark.mutate({}, { onSuccess: refresh }),
  };
}

export function useRunPipelineStep() {
  const t = useCopy();
  return useIssueMutation((args: { id: string }) => issuesApi.runPipelineStep(args.id), { success: t("issues.toast.started") });
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
  return useQuery(issueQueries.roster(projectId));
}

/** `showsRefusal` answers, when a refusal lands, whether the caller is showing it itself. */
export function useBatchRelease(projectId: string, { showsRefusal }: { showsRefusal?: () => boolean } = {}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation<CreateReleaseBatchResult, unknown, { issueIds: string[] }>({
    mutationFn: ({ issueIds }) => releaseBatchApi.create(projectId, issueIds),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: issueKeys.all });
      void qc.invalidateQueries({ queryKey: ["pipeline-runs"] });
      void qc.invalidateQueries({ queryKey: ["release-roster"] });
      toast({
        title: result.issueIds.length === 1 ? t("issues.toast.batchStartedOne") : t("issues.toast.batchStarted", { n: result.issueIds.length }),
        tone: "success",
      });
    },
    onError: (err) => {
      if (showsRefusal?.()) return;
      toast({
        title: t("issues.toast.batchFailed"),
        description: formatApiError(err),
        tone: "error",
      });
    },
  });
}

/** Outcome tally of a bulk apply. `skipped` = the server refused the change
 *  (403 permission, 409 stale, 422 invalid transition / no-op / a checklist gap) — surfaced, not
 *  failed, each by its issue and core's own words for why (REQ-34 BC-2, BC-18). */
interface BulkSummary {
  updated: number;
  skipped: number;
  failed: number;
  why: { key: string; detail: string }[];
}

/** An issue of a bulk apply, by the key a person reads it under. */
export interface BulkIssue {
  id: string;
  displayId: string;
}

/** Max concurrent requests per wave — a no-limit selection shouldn't open 100
 *  sockets at once. */
const BULK_CHUNK = 8;

export function useBulkUpdateIssues() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
  return useMutation<BulkSummary, unknown, { issues: BulkIssue[]; update: BulkUpdate }>({
    mutationFn: async ({ issues, update }) => {
      const summary: BulkSummary = { updated: 0, skipped: 0, failed: 0, why: [] };
      const apply = (id: string) =>
        update.kind === "status"
          ? issuesApi.transition(id, update.toStatus)
          : issuesApi.patch(id, { priority: update.priority });
      for (let i = 0; i < issues.length; i += BULK_CHUNK) {
        const wave = issues.slice(i, i + BULK_CHUNK);
        const results = await Promise.allSettled(wave.map((issue) => apply(issue.id)));
        results.forEach((r, n) => {
          if (r.status === "fulfilled") summary.updated++;
          else if (r.reason instanceof ApiError && [403, 409, 422].includes(r.reason.status)) {
            summary.skipped++;
            const detail = refusalsOf(r.reason).map((x) => x.detail).join(" ");
            summary.why.push({ key: wave[n]?.displayId ?? "", detail });
          } else summary.failed++;
        });
      }
      return summary;
    },
    onSuccess: (summary, { issues }) => {
      void qc.invalidateQueries({ queryKey: issueKeys.all });
      for (const { id } of issues) void qc.invalidateQueries({ queryKey: ["issue", id] });
      const parts = [t("issues.toast.bulkUpdated", { n: summary.updated })];
      if (summary.skipped) parts.push(t("issues.toast.bulkSkipped", { n: summary.skipped }));
      if (summary.failed) parts.push(t("issues.toast.bulkFailedN", { n: summary.failed }));
      const why = summary.why.map((w) => t("issues.toast.bulkSkippedWhy", w)).join(" ");
      toast({
        title: parts.join(" · "),
        ...(why ? { description: why } : {}),
        tone: summary.failed > 0 ? "error" : "success",
      });
    },
    onError: (err) => {
      toast({ title: t("issues.toast.bulkFailed"), description: formatApiError(err), tone: "error" });
    },
  });
}

/** Add or retract a `blocks` edge on one issue; the edges and the issue's standing are re-read after. */
export function useBlockerEdit(issueId: string, projectId: string) {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["issue"] });
    void qc.invalidateQueries({ queryKey: issueKeys.all });
  };
  const add = useMutation({ mutationFn: (key: string) => issuesApi.addBlocker(issueId, projectId, key), onSuccess: done });
  const remove = useMutation({ mutationFn: (edgeId: string) => issuesApi.removeEdge(issueId, edgeId), onSuccess: done });
  return { add, remove };
}
