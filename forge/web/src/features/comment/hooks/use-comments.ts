import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { commentApi } from '../api/comment-api';
import type { CommentFormData } from '../types';

function useInvalidateComments(issueDocumentId: string) {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: ['comments', issueDocumentId] });
    queryClient.invalidateQueries({ queryKey: ['activities', issueDocumentId] });
  };
}

export function useComments(issueDocumentId: string) {
  return useQuery({
    queryKey: ['comments', issueDocumentId],
    queryFn: () => commentApi.getByIssue(issueDocumentId),
    enabled: !!issueDocumentId,
  });
}

export function useCreateComment(issueDocumentId: string) {
  const invalidate = useInvalidateComments(issueDocumentId);
  return useMutation({
    mutationFn: (data: CommentFormData) => commentApi.create(issueDocumentId, data),
    onSuccess: invalidate,
  });
}

export function useUpdateComment(issueDocumentId: string) {
  const invalidate = useInvalidateComments(issueDocumentId);
  return useMutation({
    mutationFn: ({ documentId, body }: { documentId: string; body: string }) =>
      commentApi.update(documentId, { body }),
    onSuccess: invalidate,
  });
}

export function useDeleteComment(issueDocumentId: string) {
  const invalidate = useInvalidateComments(issueDocumentId);
  return useMutation({
    mutationFn: (documentId: string) => commentApi.delete(documentId),
    onSuccess: invalidate,
  });
}
