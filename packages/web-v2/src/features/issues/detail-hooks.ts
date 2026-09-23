"use client";


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { issueDetailApi } from "./detail-api";

// ISS-1160 — `id` is the display key as often as the row uuid; `projectId` is
// what lets it resolve. Optional here (some callers hold only a uuid already),
// required by the screen that reaches these hooks off a followed link.
export function useIssue(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["issue", id],
    queryFn: () => issueDetailApi.get(id as string, projectId),
    enabled: !!id,
  });
}

export function useComments(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["comments", id],
    queryFn: () => issueDetailApi.listComments(id as string, projectId),
    enabled: !!id,
  });
}

export function useActivity(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["activities", id],
    queryFn: () => issueDetailApi.listActivity(id as string, 50, projectId),
    enabled: !!id,
  });
}

export function useTasks(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["tasks", id],
    queryFn: () => issueDetailApi.listTasks(id as string, projectId),
    enabled: !!id,
  });
}

export function useAttachments(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["issue", id, "attachments"],
    queryFn: () => issueDetailApi.listAttachments(id as string, projectId),
    enabled: !!id,
  });
}

/** Step-handoff rows for the issue (per-stage artifact cards, ISS-377). Keyed
 *  under the `['issue', id, …]` prefix so the event-router's `['issue', id]`
 *  invalidation (issue.updated / pipelineHealth.changed) refreshes it for free.
 */
export function useStepHandoffs(projectId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["issue", id, "handoffs"],
    queryFn: () => issueDetailApi.listHandoffs(projectId as string, id as string),
    enabled: !!id && !!projectId,
    staleTime: 30_000,
    select: (data) => data.rows,
  });
}

/** Per-stage duration + cost for the issue (ISS-377 gap E). The REST view is
 *  project-scoped with no issueId filter, so we fetch the 90-day window and
 *  filter to this issue in `select`. Same `['issue', id, …]` prefix for free
 *  WS invalidation. */
export function useStepDurations(projectId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ["issue", id, "step-durations"],
    queryFn: () => issueDetailApi.stepDurations(projectId as string),
    enabled: !!id && !!projectId,
    staleTime: 30_000,
    select: (rows) => rows.filter((r) => r.issueId === id),
  });
}

export function useCreateComment(id: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async (args: { body: string; parentId?: string; files?: File[] }) => {
      const created = await issueDetailApi.createComment(id, args.body, args.parentId);
      const files = args.files ?? [];
      if (files.length > 0) {
        // Sequential upload keeps it simple and avoids server contention. On a
        // failure the comment body is already posted, so surface a toast rather
        // than throwing (which would mislabel it "Couldn't post comment").
        for (const file of files) {
          try {
            await issueDetailApi.uploadCommentAttachment(created.id, file);
          } catch (err) {
            toast({
              title: "Comment posted, but an attachment failed",
              description: `${file.name}: ${formatApiError(err)}`,
              tone: "error",
            });
          }
        }
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", id] });
      qc.invalidateQueries({ queryKey: ["activities", id] });
    },
    onError: (err) => {
      toast({ title: "Couldn't post comment", description: formatApiError(err), tone: "error" });
    },
  });
}
