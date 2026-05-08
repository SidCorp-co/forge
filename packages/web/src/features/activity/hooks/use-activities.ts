import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { activityApi } from '../api/activity-api';

const PAGE_SIZE = 50;

export function useActivities(issueDocumentId: string) {
  return useInfiniteQuery({
    queryKey: ['activities', issueDocumentId],
    queryFn: ({ pageParam }) =>
      activityApi.getByIssue(issueDocumentId, {
        before: pageParam ?? undefined,
        limit: PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: !!issueDocumentId,
  });
}

export function useEvaluateActivity(issueDocumentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      activityId,
      verdict,
      note,
    }: {
      activityId: string;
      verdict: 'approve' | 'reject';
      note?: string;
    }) => activityApi.evaluate(issueDocumentId, activityId, verdict, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['activities', issueDocumentId] });
    },
  });
}
