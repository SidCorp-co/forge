"use client";


import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useToast } from "@/providers/toast-provider";
import { issueDetailApi } from "./detail-api";
import { canonicalIssueId, issueKeySegment, issueQueryKey } from "./derive";

// ISS-1160 — `id` is the display key as often as the row uuid; `projectId` is
// what lets it resolve. Optional here (some callers hold only a uuid already),
// required by the screen that reaches these hooks off a followed link.
export function useIssue(id: string | undefined, projectId?: string) {
  const byRef = useQuery({
    queryKey: issueQueryKey(id, projectId),
    queryFn: () => issueDetailApi.get(id as string, projectId),
    enabled: !!id,
  });
  // ISS-1327 — every invalidation names the uuid, so once it is known the screen reads that entry.
  const uuid = id ? canonicalIssueId(id, byRef.data?.id) : undefined;
  const followsUuid = !!uuid && uuid !== id;
  const byUuid = useQuery({
    queryKey: issueQueryKey(uuid, projectId),
    queryFn: () => issueDetailApi.get(uuid as string, projectId),
    enabled: followsUuid,
    initialData: followsUuid ? byRef.data : undefined,
    initialDataUpdatedAt: byRef.dataUpdatedAt,
  });
  return followsUuid ? byUuid : byRef;
}

export function useComments(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["comments", issueKeySegment(id, projectId)],
    queryFn: () => issueDetailApi.listComments(id as string, projectId),
    enabled: !!id,
  });
}

export function useActivity(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["activities", issueKeySegment(id, projectId)],
    queryFn: () => issueDetailApi.listActivity(id as string, 50, projectId),
    enabled: !!id,
  });
}

export function useAttachments(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["issue", issueKeySegment(id, projectId), "attachments"],
    queryFn: () => issueDetailApi.listAttachments(id as string, projectId),
    enabled: !!id,
  });
}


/** Record an owner's ruling on the issue as a decision, apart from the thread's chatter. */
export function useRecordDecision(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decision: { decision: string; reason: string }) => issueDetailApi.recordDecision(id, decision),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", id] });
      qc.invalidateQueries({ queryKey: ["activities", id] });
      // the issue's Decisions tab, and a requirement's that rolls this issue's up
      qc.invalidateQueries({ queryKey: ["entity-decisions"] });
      qc.invalidateQueries({ queryKey: ["requirement-decisions"] });
    },
  });
}

export function useCreateComment(id: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const t = useCopy();
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
              title: t("issues.toast.attachmentFailed"),
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
      toast({ title: t("issues.toast.commentFailed"), description: formatApiError(err), tone: "error" });
    },
  });
}
