import type { Issue, IssueCreateInput, IssuePatchInput } from '@forge/contracts';
import { apiClient, apiClientList } from '@/lib/api/client';

export interface IssueListParams {
  projectId: string;
  limit?: number;
  offset?: number;
  status?: string;
  priority?: string;
  assigneeId?: string;
}

export interface IssueSearchParams {
  projectId: string;
  q?: string;
  status?: string[];
  priority?: string[];
  label?: string[];
  assignee?: string;
  limit?: number;
  offset?: number;
}

export interface IssueDetailResponse extends Issue {
  labels: Array<{ id: string; name: string; color: string | null }>;
  comments: unknown[];
  activity: unknown[];
}

export interface TransitionResponse {
  id: string;
  status: string;
  reopenCount: number;
  transitionedAt: string;
}

function buildListQs(p: Omit<IssueListParams, 'projectId'>): string {
  const qs = new URLSearchParams();
  qs.set('limit', String(p.limit ?? 50));
  qs.set('offset', String(p.offset ?? 0));
  if (p.status && p.status !== 'all') qs.set('status', p.status);
  if (p.priority && p.priority !== 'all') qs.set('priority', p.priority);
  if (p.assigneeId) qs.set('assigneeId', p.assigneeId);
  return qs.toString();
}

function buildSearchQs(q: Omit<IssueSearchParams, 'projectId'>): string {
  const qs = new URLSearchParams();
  if (q.q) qs.set('q', q.q);
  q.status?.forEach((s) => qs.append('status', s));
  q.priority?.forEach((s) => qs.append('priority', s));
  q.label?.forEach((s) => qs.append('label', s));
  if (q.assignee) qs.set('assignee', q.assignee);
  qs.set('limit', String(q.limit ?? 50));
  qs.set('offset', String(q.offset ?? 0));
  return qs.toString();
}

export const issueApi = {
  list: (p: IssueListParams) =>
    apiClientList<Issue>(`/projects/${p.projectId}/issues?${buildListQs(p)}`),

  search: (p: IssueSearchParams) =>
    apiClientList<Issue>(`/projects/${p.projectId}/issues/search?${buildSearchQs(p)}`),

  get: (id: string) => apiClient<IssueDetailResponse>(`/issues/${id}`),

  getByDisplay: (projectId: string, displayId: string) =>
    apiClient<IssueDetailResponse>(
      `/projects/${projectId}/issues/by-display/${displayId}`,
    ),

  create: (projectId: string, input: IssueCreateInput) =>
    apiClient<Issue>(`/projects/${projectId}/issues`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  patch: (id: string, input: IssuePatchInput) =>
    apiClient<Issue>(`/issues/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  transition: (
    id: string,
    input: { toStatus: string; reason?: string; override?: boolean },
  ) =>
    apiClient<TransitionResponse>(`/issues/${id}/transition`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  remove: (id: string) => apiClient<void>(`/issues/${id}`, { method: 'DELETE' }),

  runPipelineStep: (id: string, stage?: PipelineStage) =>
    apiClient<RunPipelineStepResponse>(`/issues/${id}/run-pipeline-step`, {
      method: 'POST',
      body: JSON.stringify(stage ? { stage } : {}),
    }),
};

export const PIPELINE_STAGES = [
  'triage',
  'plan',
  'code',
  'review',
  'test',
  'fix',
  'release',
  'clarify',
] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export interface RunPipelineStepResponse {
  issueId: string;
  jobId: string;
  stage: PipelineStage;
  status: 'queued';
}
