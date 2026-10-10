"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { previewsApi } from "./api";
import { previewKeys, previewQueries } from "./queries";

/** The key `lib/ws/event-router.ts` invalidates on `preview.changed`. */
export const previewKey = previewKeys.issue;


/**
 * `issueId` is the uuid, or the display key with the `projectId` it is scoped by: the issue page
 * sends this read with its first reads on the key, and hands it to the uuid once the issue answers.
 */
export function usePreview(issueId: string | undefined, projectId?: string) {
  return useQuery(previewQueries.issue(issueId, projectId));
}

/** The lane read is only meaningful once a preview was approved: before, it says there is nothing approved. */
export function useIssueLane(issueId: string, enabled: boolean) {
  return useQuery(previewQueries.lane(issueId, enabled));
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
