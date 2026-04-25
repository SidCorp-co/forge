import { apiClient, apiClientList } from '@/lib/api/client';
import type { Memory } from './types';

interface CoreMemory {
  id: string;
  projectId: string;
  source: string;
  sourceRef: string;
  textContent: string;
  metadata: Record<string, unknown> | null;
  embeddedAt: string;
  createdAt: string;
  updatedAt: string;
}

function toLegacy(row: CoreMemory): Memory {
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    documentId: row.id,
    category: (meta.category as Memory['category']) ?? 'preference',
    content: row.textContent,
    scope: 'project',
    source: 'auto',
    role: (meta.role as Memory['role']) ?? null,
    visibility: (meta.visibility as Memory['visibility']) ?? null,
    retrievalCount: typeof meta.retrievalCount === 'number' ? meta.retrievalCount : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const memoryApi = {
  list: async (projectId: string): Promise<{ data: Memory[] }> => {
    const { items } = await apiClientList<CoreMemory>(
      `/memory?projectId=${encodeURIComponent(projectId)}`,
    );
    return { data: items.map(toLegacy) };
  },

  remove: (memoryId: string) =>
    apiClient<void>(`/memory/${encodeURIComponent(memoryId)}`, {
      method: 'DELETE',
    }),
};
