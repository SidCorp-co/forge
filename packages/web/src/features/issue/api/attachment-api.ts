import { apiClient, apiMultipart } from '@/lib/api/client';
import type { IssueAttachment } from '../types';

export const issueAttachmentApi = {
  list: (issueId: string) => apiClient<IssueAttachment[]>(`/issues/${issueId}/attachments`),
  upload: (issueId: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiMultipart<IssueAttachment>(`/issues/${issueId}/attachments`, fd);
  },
  delete: (id: string) => apiClient<void>(`/attachments/${id}`, { method: 'DELETE' }),
};
