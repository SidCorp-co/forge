"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { issueKeySegment } from "@/lib/api/ref-bridge";
import { type IssueLane, previewsApi } from "./api";

/** The key `lib/ws/event-router.ts` invalidates on `preview.changed`. */
export const previewKey = (issueId: string | undefined) => ["preview", issueId] as const;

/** A preview still starting is read again on a short clock, so a missed frame cannot leave it starting for good. */
const STARTING_POLL_MS = 3000;

/**
 * `issueId` is the uuid, or the display key with the `projectId` it is scoped by: the issue page
 * sends this read with its first reads on the key, and hands it to the uuid once the issue answers.
 */
export function usePreview(issueId: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: ["preview", issueKeySegment(issueId, projectId)],
    queryFn: () => previewsApi.ofIssue(issueId as string, projectId),
    enabled: !!issueId,
    refetchInterval: (q) => (q.state.data?.state === "starting" ? STARTING_POLL_MS : false),
  });
}

/** The lane read is only meaningful once a preview was approved: before, it says there is nothing approved. */
export function useIssueLane(issueId: string, enabled: boolean) {
  return useQuery<IssueLane>({
    queryKey: ["preview", issueId, "lane"],
    queryFn: () => previewsApi.lane(issueId),
    enabled,
  });
}

function usePreviewAct<V>(issueId: string, act: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: act,
    onSettled: () => qc.invalidateQueries({ queryKey: previewKey(issueId) }),
  });
}

export const useOpenPreview = (issueId: string) => usePreviewAct<void>(issueId, () => previewsApi.open(issueId));
export const useApprovePreview = (issueId: string) => usePreviewAct<string>(issueId, (id) => previewsApi.approve(id));
export const useAbandonPreview = (issueId: string) => usePreviewAct<string>(issueId, (id) => previewsApi.abandon(id));

/** Writes no record: the message goes to the run, which edits, and the preview reloads itself. */
export function useSendPreviewMessage() {
  return useMutation({ mutationFn: ({ id, text }: { id: string; text: string }) => previewsApi.message(id, text) });
}
