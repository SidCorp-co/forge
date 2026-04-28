import { apiClient } from '@/lib/api/client';
import type {
  PipelineConfigPatch,
  PipelineConfigResponse,
} from './types';

export const pipelineConfigApi = {
  /** GET /api/projects/:projectId/pipeline-config */
  get: (projectId: string) =>
    apiClient<PipelineConfigResponse>(`/projects/${projectId}/pipeline-config`),

  /** PATCH /api/projects/:projectId/pipeline-config — atomic jsonb merge backend-side. */
  patch: (projectId: string, patch: PipelineConfigPatch) =>
    apiClient<{ pipelineConfig: PipelineConfigResponse['pipelineConfig'] }>(
      `/projects/${projectId}/pipeline-config`,
      {
        method: 'PATCH',
        body: JSON.stringify(patch),
      },
    ),
};
