import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { activityApi } from '../api/activity-api';

export function useActivities(issueDocumentId: string) {
  return useQuery({
    queryKey: ['activities', issueDocumentId],
    queryFn: () => activityApi.getByIssue(issueDocumentId),
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
