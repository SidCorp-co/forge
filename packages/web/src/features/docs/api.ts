// v1 feature module: docs — REST surface. Reuses the ISS-305 docs API
// (`packages/core/src/docs/routes.ts`); no new endpoint.
import { apiClient } from '@/lib/api/client';
import type { DocContent, DocsTree } from './types';

export const docsApi = {
  /** `GET /api/projects/:projectId/docs` — the project's markdown tree. */
  tree: (projectId: string) => apiClient<DocsTree>(`/projects/${projectId}/docs`),

  /** `GET /api/projects/:projectId/docs/content?path=…` — one file's markdown. */
  content: (projectId: string, path: string) =>
    apiClient<DocContent>(`/projects/${projectId}/docs/content?path=${encodeURIComponent(path)}`),
};
