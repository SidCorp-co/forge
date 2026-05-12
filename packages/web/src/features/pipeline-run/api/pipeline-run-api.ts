import { apiClient, apiClientList } from '@/lib/api/client';
import type {
  PipelineRun,
  PipelineRunListItem,
  PipelineRunStatus,
} from '../types';

export interface PipelineRunListParams {
  projectId: string;
  status?: PipelineRunStatus;
  issueId?: string;
  limit?: number;
  offset?: number;
}

export interface PipelineRunCancelResponse {
  run: PipelineRun;
  cancelledJobIds: string[];
  abortedSessionIds: string[];
  deviceIdsNotified: string[];
}

function listQuery(p: PipelineRunListParams): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(p.limit ?? 50));
  qs.set('offset', String(p.offset ?? 0));
  if (p.status) qs.set('status', p.status);
  if (p.issueId) qs.set('issueId', p.issueId);
  return qs.toString();
}

export const pipelineRunApi = {
  list: (p: PipelineRunListParams) =>
    apiClientList<PipelineRunListItem>(
      `/projects/${p.projectId}/pipeline-runs?${listQuery(p)}`,
    ),

  get: (id: string) => apiClient<PipelineRun>(`/pipeline-runs/${id}`),

  /**
   * Pause/resume/cancel return shapes from `runs-control.ts`:
   *   pause/resume → raw PipelineRunRow (no `steps`/`cost`)
   *   cancel       → PipelineRunCancelResponse
   * Callers should invalidate the detail query and re-fetch instead of
   * trusting the mutation response shape.
   */
  pause: (id: string) =>
    apiClient<Partial<PipelineRun>>(`/pipeline-runs/${id}/pause`, {
      method: 'POST',
    }),
  resume: (id: string) =>
    apiClient<Partial<PipelineRun>>(`/pipeline-runs/${id}/resume`, {
      method: 'POST',
    }),
  cancel: (id: string) =>
    apiClient<PipelineRunCancelResponse>(`/pipeline-runs/${id}/cancel`, {
      method: 'POST',
    }),
};
