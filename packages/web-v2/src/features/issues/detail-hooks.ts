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

/** Post a comment, then upload any staged files via per-file multipart
 *  (`POST /api/comments/:commentId/attachments`). Create-then-upload mirrors v1:
 *  the create endpoint takes only `body`/`parentId`. An upload failure does NOT
 *  discard the already-created comment — we toast and still invalidate so the
 *  comment (and any files that did upload) appears. Invalidate the comment tree
 *  + activity feed on success. */
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
