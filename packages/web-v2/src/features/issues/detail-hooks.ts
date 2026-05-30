"use client";

// web-v2 feature module: issues — detail React Query hooks (Part B).
//
// Query-key contract (must match `lib/ws/event-router.ts`):
//   issue     → ['issue', id]                 (issue.* events)
//   comments  → ['comments', id]              (comment.* events)
//   activity  → ['activities', id]            (issue.* / comment.* / dep events)
//   tasks     → ['tasks', id]                 (no WS event → invalidate on mutate)
//   attachments → ['issue', id, 'attachments']
// Reuse `useIssueDeps`/`useIssueCost`/`useProjectMembers` from `./hooks`.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useToast } from "@/providers/toast-provider";
import { issueDetailApi } from "./detail-api";

export function useIssue(id: string | undefined) {
  return useQuery({
    queryKey: ["issue", id],
    queryFn: () => issueDetailApi.get(id as string),
    enabled: !!id,
  });
}

export function useComments(id: string | undefined) {
  return useQuery({
    queryKey: ["comments", id],
    queryFn: () => issueDetailApi.listComments(id as string),
    enabled: !!id,
  });
}

export function useActivity(id: string | undefined) {
  return useQuery({
    queryKey: ["activities", id],
    queryFn: () => issueDetailApi.listActivity(id as string),
    enabled: !!id,
  });
}

export function useTasks(id: string | undefined) {
  return useQuery({
    queryKey: ["tasks", id],
    queryFn: () => issueDetailApi.listTasks(id as string),
    enabled: !!id,
  });
}

export function useAttachments(id: string | undefined) {
  return useQuery({
    queryKey: ["issue", id, "attachments"],
    queryFn: () => issueDetailApi.listAttachments(id as string),
    enabled: !!id,
  });
}

/** Post a comment; invalidate the comment tree + activity feed on success. */
export function useCreateComment(id: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: (args: { body: string; parentId?: string }) =>
      issueDetailApi.createComment(id, args.body, args.parentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", id] });
      qc.invalidateQueries({ queryKey: ["activities", id] });
    },
    onError: (err) => {
      toast({ title: "Couldn't post comment", description: formatApiError(err), tone: "error" });
    },
  });
}
