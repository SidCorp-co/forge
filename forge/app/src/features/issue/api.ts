import * as SecureStore from 'expo-secure-store';
import { apiClient } from '@/lib/api-client';
import { API_URL } from '@/lib/constants';
import type { Issue, IssueFormData } from './types';

export const issueApi = {
  getAll: (projectSlug?: string) => {
    const filter = projectSlug
      ? `?filters[project][slug][$eq]=${projectSlug}&populate=*`
      : '?populate=*';
    return apiClient<{ data: Issue[] }>(`/issues${filter}`);
  },

  getById: (id: string) =>
    apiClient<{ data: Issue }>(`/issues/${id}?populate=*`),

  create: (data: IssueFormData) =>
    apiClient<{ data: Issue }>('/issues', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),

  update: (id: string, data: Partial<Issue>) =>
    apiClient<{ data: Issue }>(`/issues/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  uploadImage: async (issueDocumentId: string, file: { uri: string; name: string; type: string }) => {
    const token = await SecureStore.getItemAsync('jwt');
    const formData = new FormData();
    formData.append('files', file as unknown as Blob);
    formData.append('ref', 'api::issue.issue');
    formData.append('refId', issueDocumentId);
    formData.append('field', 'attachments');

    const res = await fetch(`${API_URL}/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) throw new Error('Upload failed');
    return res.json();
  },

  uploadFile: async (file: { uri: string; name: string; type: string }): Promise<{ id: number; url: string; name: string } | null> => {
    const token = await SecureStore.getItemAsync('jwt');
    const formData = new FormData();
    formData.append('files', file as unknown as Blob);

    const res = await fetch(`${API_URL}/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data[0]?.id) return { id: data[0].id, url: data[0].url, name: file.name };
    return null;
  },

  enrich: (id: string) =>
    apiClient<{ data: { documentId: string; status: string } }>(`/issues/${id}/enrich`, {
      method: 'POST',
    }),

  delete: (id: string) =>
    apiClient(`/issues/${id}`, { method: 'DELETE' }),
};
