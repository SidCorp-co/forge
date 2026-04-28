import { apiClient } from '@/lib/api/client';
import type { Label, LabelFormData } from '../types';

interface CoreLabel {
  id: string;
  projectId: string;
  name: string;
  color: string;
  createdAt: string;
}

function toLegacy(row: CoreLabel): Label {
  return {
    id: 0,
    documentId: row.id,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    name: row.name,
    color: row.color,
    description: null,
    project: { id: 0, documentId: row.projectId },
  } as Label;
}

export const labelApi = {
  getByProject: async (projectId: string): Promise<{ data: Label[] }> => {
    const rows = await apiClient<CoreLabel[]>(`/projects/${projectId}/labels`);
    return { data: rows.map(toLegacy) };
  },

  create: async (data: LabelFormData): Promise<{ data: Label }> => {
    const row = await apiClient<CoreLabel>(`/projects/${data.project}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name: data.name, color: data.color }),
    });
    return { data: toLegacy(row) };
  },

  update: async (labelId: string, data: Partial<LabelFormData>): Promise<{ data: Label }> => {
    const body: Record<string, unknown> = {};
    if (data.name !== undefined) body.name = data.name;
    if (data.color !== undefined) body.color = data.color;
    const row = await apiClient<CoreLabel>(`/labels/${labelId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return { data: toLegacy(row) };
  },

  delete: (labelId: string) =>
    apiClient<void>(`/labels/${labelId}`, { method: 'DELETE' }),
};
