"use client";

// web-v2 feature module: feedback — React Query hooks.
// Keyed `['feedback', projectId]`; mark-reviewed mutation invalidates on success.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { feedbackApi } from "./api";
import type { FeedbackFilters } from "./types";

export function useFeedbackReports(projectId: string | undefined, filters?: FeedbackFilters) {
  return useQuery({
    queryKey: ["feedback", projectId, filters],
    queryFn: () => feedbackApi.list(projectId as string, filters),
    enabled: !!projectId,
  });
}

export function useMarkFeedbackReviewed(projectId: string | undefined) {
  const qc = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) =>
      feedbackApi.markReviewed(id, reviewed),
    onSuccess: (_data, { reviewed }) => {
      qc.invalidateQueries({ queryKey: ["feedback", projectId] });
      toast({ title: reviewed ? "Marked as reviewed" : "Marked as unreviewed", tone: "success" });
    },
    onError: (err) => {
      toast({ title: "Action failed", description: formatApiError(err), tone: "error" });
    },
  });
}
