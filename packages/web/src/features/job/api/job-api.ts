import type { Job, JobEvent } from '@forge/contracts';
import { apiClient, apiClientList } from '@/lib/api/client';
import type { JobType, ModelTier } from '../types';

export interface JobListParams {
  projectId: string;
  limit?: number;
  offset?: number;
  status?: string;
  type?: JobType;
  issueId?: string;
}

export interface JobCreateInput {
  type: JobType;
  payload?: Record<string, unknown>;
  issueId?: string | null;
  modelTier?: ModelTier | null;
}

export interface JobEventsParams {
  jobId: string;
  limit?: number;
  sinceSeq?: number;
}

export interface JobDetailResponse extends Job {
  device: { id: string; name: string; status: string } | null;
}

export const jobApi = {
  list: (p: JobListParams) => {
    const qs = new URLSearchParams();
    qs.set('limit', String(p.limit ?? 50));
    qs.set('offset', String(p.offset ?? 0));
    if (p.status) qs.set('status', p.status);
    if (p.type) qs.set('type', p.type);
    if (p.issueId) qs.set('issueId', p.issueId);
    return apiClientList<Job>(`/projects/${p.projectId}/jobs?${qs}`);
  },

  get: (id: string) => apiClient<JobDetailResponse>(`/jobs/${id}`),

  create: (projectId: string, input: JobCreateInput) =>
    apiClient<Job>(`/projects/${projectId}/jobs`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  cancel: (id: string) =>
    apiClient<Job>(`/jobs/${id}/cancel`, { method: 'POST' }),

  events: ({ jobId, limit, sinceSeq }: JobEventsParams) => {
    const qs = new URLSearchParams();
    qs.set('limit', String(limit ?? 100));
    if (sinceSeq !== undefined) qs.set('sinceSeq', String(sinceSeq));
    // GET endpoint is added in F3; until then the call surfaces as a 404 via
    // ApiError. The hook below short-circuits with useUnimplemented until
    // F3 lands.
    return apiClientList<JobEvent>(`/jobs/${jobId}/events?${qs}`);
  },
};
