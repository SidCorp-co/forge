import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { Comment, CommentFormData } from './types';

const commentApi = {
  getByIssue: (issueDocumentId: string) =>
    apiClient<{ data: Comment[] }>(
      `/comments?filters[issue][documentId][$eq]=${issueDocumentId}&populate=*`,
    ),

  create: (data: CommentFormData) =>
    apiClient<{ data: Comment }>('/comments', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
};

export function useComments(issueDocumentId: string) {
  return useQuery({
    queryKey: ['comments', issueDocumentId],
    queryFn: () => commentApi.getByIssue(issueDocumentId),
    enabled: !!issueDocumentId,
  });
}

export function useCreateComment(issueDocumentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CommentFormData) => commentApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments', issueDocumentId] });
    },
  });
}
