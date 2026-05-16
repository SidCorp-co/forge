import type { Issue, IssueCreateInput, IssuePatchInput } from '@forge/contracts';
import { apiClient, apiClientList } from '@/lib/api/client';
import type { IssuePriority, IssueStatus } from '@/features/issue/types';

export const ISSUE_SORT_VALUES = [
  'createdAt:desc',
  'createdAt:asc',
  'updatedAt:desc',
  'updatedAt:asc',
  'priority:asc',
  'priority:desc',
] as const;
export type IssueSort = (typeof ISSUE_SORT_VALUES)[number];

export interface IssueListParams {
  projectId: string;
  limit?: number;
  offset?: number;
  status?: string;
  priority?: string;
  assigneeId?: string;
  category?: string;
  sort?: IssueSort;
  withAgentSessions?: boolean;
}

export interface IssueSearchParams {
  projectId: string;
  q?: string;
  status?: string[];
  priority?: string[];
  label?: string[];
  assignee?: string;
  category?: string;
  sort?: IssueSort;
  limit?: number;
  offset?: number;
  withAgentSessions?: boolean;
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
  if (p.category && p.category !== 'all') qs.set('category', p.category);
  if (p.sort) qs.set('sort', p.sort);
  if (p.withAgentSessions) qs.set('withAgentSessions', '1');
  return qs.toString();
}

function buildSearchQs(q: Omit<IssueSearchParams, 'projectId'>): string {
  const qs = new URLSearchParams();
  if (q.q) qs.set('q', q.q);
  q.status?.forEach((s) => qs.append('status', s));
  q.priority?.forEach((s) => qs.append('priority', s));
  q.label?.forEach((s) => qs.append('label', s));
  if (q.assignee) qs.set('assignee', q.assignee);
  if (q.category && q.category !== 'all') qs.set('category', q.category);
  if (q.sort) qs.set('sort', q.sort);
  qs.set('limit', String(q.limit ?? 50));
  qs.set('offset', String(q.offset ?? 0));
  if (q.withAgentSessions) qs.set('withAgentSessions', '1');
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

  getCostSummary: (id: string) =>
    apiClient<IssueCostSummary>(`/issues/${id}/cost-summary`),

  getPipelineTiming: (params: { projectId: string; from?: string; to?: string }) => {
    const qs = new URLSearchParams({ projectId: params.projectId });
    if (params.from) qs.set('from', params.from);
    if (params.to) qs.set('to', params.to);
    return apiClient<PipelineTimingResponse>(`/issues/pipeline-timing?${qs.toString()}`);
  },

  setManualHold: (id: string, value: boolean) =>
    apiClient<{ issueId: string; manualHold: boolean }>(`/issues/${id}/manual-hold`, {
      method: 'PATCH',
      body: JSON.stringify({ value }),
    }),

  batchPatch: (input: BatchPatchInput) =>
    apiClient<BatchPatchResponse>('/issues/batch', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  enrich: (id: string) =>
    apiClient<EnrichResponse>(`/issues/${id}/enrich`, { method: 'POST' }),

  getDependencies: (id: string) =>
    apiClient<DependencyEdgesResponse>(`/issues/${id}/dependencies`),

  addDependency: (id: string, body: AddDependencyInput) =>
    apiClient<AddDependencyResponse>(`/issues/${id}/dependencies`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteDependency: (id: string, edgeId: string) =>
    apiClient<{ deleted: true }>(`/issues/${id}/dependencies/${edgeId}`, {
      method: 'DELETE',
    }),
};

export interface IssueCostSummary {
  issueId: string;
  projectId: string;
  estimatedCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
  sampleCount: number;
}

export interface PipelineTimingStat {
  status: string;
  sampleCount: number;
  avgMs: number;
  medianMs: number;
  p90Ms: number;
}

export interface PipelineTimingResponse {
  projectId: string;
  stats: PipelineTimingStat[];
}

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

export interface EnrichResponse {
  issueId: string;
  jobId: string;
  status: string;
}

export const DEPENDENCY_KINDS = [
  'blocks',
  'relates',
  'duplicates',
  'parent',
  'decomposes',
] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

export interface DependencyEdge {
  id: string;
  projectId: string;
  fromIssueId: string;
  toIssueId: string;
  kind: DependencyKind;
  reason: string | null;
  validUntil: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface DependencyEdgesResponse {
  outgoing: DependencyEdge[];
  incoming: DependencyEdge[];
}

export interface AddDependencyInput {
  dependsOnId: string;
  kind: DependencyKind;
  reason?: string;
}

export interface AddDependencyResponse {
  id: string;
  created: boolean;
}

// Mirrors `batchPatchBodySchema.data` on the server. `complexity` is
// intentionally absent: BulkActionBar does not expose a complexity selector,
// so the surface stays minimal on both sides.
export interface BatchPatchData {
  status?: IssueStatus;
  priority?: IssuePriority;
  category?: string | null;
  manualHold?: boolean;
}

export interface BatchPatchInput {
  ids: string[];
  data: BatchPatchData;
}

export type BatchPatchSkipReason =
  | 'forbidden'
  | 'not_found'
  | 'illegal_transition'
  | 'no_op'
  | 'reopen_cap_exceeded'
  | 'stale';

export interface BatchPatchResponse {
  updated: Array<{
    id: string;
    displayId: string;
    skipReason?: BatchPatchSkipReason;
  }>;
  skipped: Array<{ id: string; reason: BatchPatchSkipReason }>;
  failed: Array<{ id: string; error: string }>;
}
