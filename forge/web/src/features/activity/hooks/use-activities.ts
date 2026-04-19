import { useQuery } from '@tanstack/react-query';
import { activityApi } from '../api/activity-api';

export function useActivities(issueDocumentId: string) {
  return useQuery({
    queryKey: ['activities', issueDocumentId],
    queryFn: () => activityApi.getByIssue(issueDocumentId),
    enabled: !!issueDocumentId,
  });
}
