import { apiClient, apiUpload } from '@/lib/api/client';
import type { Issue, IssueFormData, IssueCostSummary, PipelineTimingResponse } from '../types';

export interface IssueListParams {
    projectSlug?: string;
    page?: number;
    pageSize?: number;
    status?: string;
    priority?: string;
    category?: string;
    search?: string;
    sort?: string; // e.g. "createdAt:desc", "priority:asc", "updatedAt:desc"
}

export interface IssueListResponse {
    data: Issue[];
    meta: {
        pagination: {
            page: number;
            pageSize: number;
            pageCount: number;
            total: number;
        };
    };
}

// Fields needed for issue list/board views (excludes heavy fields like description, plan, aiSummary)
const LIST_FIELDS = ['title', 'status', 'priority', 'complexity', 'category', 'reportedBy', 'agentStatus', 'manualHold', 'changeHistory', 'createdAt', 'updatedAt'];

function appendListFields(qs: URLSearchParams) {
    LIST_FIELDS.forEach((f, i) => qs.set(`fields[${i}]`, f));
    qs.set('populate[labels][fields][0]', 'name');
    qs.set('populate[labels][fields][1]', 'color');
    qs.set('populate[agentSessions][fields][0]', 'status');
    qs.set('populate[agentSessions][fields][1]', 'metadata');
    qs.set('populate[agentSessions][fields][2]', 'title');
}

export const issueApi = {
    getAll: (params: IssueListParams = {}) => {
        const qs = new URLSearchParams();
        appendListFields(qs);
        qs.set('pagination[page]', String(params.page ?? 1));
        qs.set('pagination[pageSize]', String(params.pageSize ?? 10));
        if (params.projectSlug) qs.set('filters[project][slug][$eq]', params.projectSlug);
        if (params.status && params.status !== 'all') {
            const statuses = params.status.split(',');
            statuses.forEach((s, i) => qs.set(`filters[status][$in][${i}]`, s));
        }
        if (params.priority && params.priority !== 'all') qs.set('filters[priority][$eq]', params.priority);
        if (params.category && params.category !== 'all') qs.set('filters[category][$eq]', params.category);
        if (params.search) qs.set('filters[title][$containsi]', params.search);
        if (params.sort) qs.set('sort', params.sort);
        else qs.set('sort', 'createdAt:desc');
        return apiClient<IssueListResponse>(`/issues?${qs.toString()}`);
    },

    getAllUnpaginated: (projectSlug?: string) => {
        const qs = new URLSearchParams();
        appendListFields(qs);
        qs.set('populate[project][fields][0]', 'slug');
        qs.set('populate[project][fields][1]', 'name');
        qs.set('pagination[pageSize]', '9999');
        qs.set('sort', 'createdAt:desc');
        if (projectSlug) qs.set('filters[project][slug][$eq]', projectSlug);
        return apiClient<{ data: Issue[] }>(`/issues?${qs.toString()}`);
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

    uploadImage: async (issueDocumentId: string, file: File) => {
        const formData = new FormData();
        formData.append('files', file);
        formData.append('ref', 'api::issue.issue');
        formData.append('refId', issueDocumentId);
        formData.append('field', 'attachments');
        return apiUpload(formData);
    },

    uploadFile: async (file: File): Promise<{ id: number; url: string; name: string } | null> => {
        const formData = new FormData();
        formData.append('files', file);
        try {
            const data = await apiUpload(formData);
            if (data[0]?.id) return { id: data[0].id, url: data[0].url, name: file.name };
            return null;
        } catch {
            return null;
        }
    },

    enrich: (id: string) =>
        apiClient<{ data: { documentId: string; status: string } }>(`/issues/${id}/enrich`, {
            method: 'POST',
        }),

    getCostSummary: (documentId: string) =>
        apiClient<{ data: IssueCostSummary }>(`/issues/${documentId}/cost-summary`).then((res) => res.data),

    getGateIssues: (projectSlug: string) => {
        const qs = new URLSearchParams();
        qs.set('populate', '*');
        qs.set('pagination[pageSize]', '25');
        qs.set('sort', 'updatedAt:desc');
        qs.set('filters[project][slug][$eq]', projectSlug);
        qs.set('filters[status][$in][0]', 'waiting');
        qs.set('filters[status][$in][1]', 'developed');
        qs.set('filters[status][$in][2]', 'staging');
        qs.set('filters[status][$in][3]', 'needs_info');
        qs.set('filters[status][$in][4]', 'on_hold');
        return apiClient<{ data: Issue[] }>(`/issues?${qs.toString()}`);
    },

    getPipelineTiming: (params?: { from?: string; to?: string }) => {
        const qs = new URLSearchParams();
        if (params?.from) qs.set('from', params.from);
        if (params?.to) qs.set('to', params.to);
        const query = qs.toString();
        return apiClient<{ data: PipelineTimingResponse }>(`/issues/pipeline-timing${query ? `?${query}` : ''}`).then((res) => res.data);
    },

    delete: (id: string) =>
        apiClient(`/issues/${id}`, { method: 'DELETE' }),
};
