'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { issueAttachmentApi } from '../api/attachment-api';
import type { IssueAttachment } from '../types';

const listKey = (issueId: string) => ['issue', issueId, 'attachments'] as const;

export function useIssueAttachments(issueId: string) {
  return useQuery<IssueAttachment[]>({
    queryKey: listKey(issueId),
    queryFn: () => issueAttachmentApi.list(issueId),
    enabled: !!issueId,
  });
}

export function useUploadIssueAttachment(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => issueAttachmentApi.upload(issueId, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(issueId) });
      qc.invalidateQueries({ queryKey: ['activities', issueId] });
    },
  });
}

export function useDeleteIssueAttachment(issueId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => issueAttachmentApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: listKey(issueId) });
      qc.invalidateQueries({ queryKey: ['activities', issueId] });
    },
  });
}
