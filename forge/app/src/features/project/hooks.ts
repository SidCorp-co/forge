import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';
import type { Project, ProjectUser } from './types';

const projectApi = {
  getAll: () =>
    apiClient<{ data: Project[] }>('/projects?populate=*'),

  getBySlug: (slug: string) =>
    apiClient<{ data: Project[] }>(
      `/projects?filters[slug][$eq]=${slug}&populate=*`,
    ).then((res) => ({ data: res.data[0] ?? null })),

  getById: (id: string) =>
    apiClient<{ data: Project }>(`/projects/${id}?populate=*`),

  update: (docId: string, data: Record<string, unknown>) =>
    apiClient<{ data: Project }>(`/projects/${docId}`, {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }),

  addMember: (projectDocId: string, userDocId: string) =>
    apiClient<{ data: Project }>(`/projects/${projectDocId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { members: { connect: [userDocId] } } }),
    }),

  removeMember: (projectDocId: string, userDocId: string) =>
    apiClient<{ data: Project }>(`/projects/${projectDocId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { members: { disconnect: [userDocId] } } }),
    }),

  searchUsers: (search: string) =>
    apiClient<ProjectUser[]>(
      `/users?filters[username][$containsi]=${encodeURIComponent(search)}`,
    ),

  setDefaultDevice: (projectDocId: string, deviceDocId: string | null) =>
    apiClient<{ data: Project }>(`/projects/${projectDocId}`, {
      method: 'PUT',
      body: JSON.stringify({ data: { defaultDevice: deviceDocId } }),
    }),
};

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: projectApi.getAll,
  });
}

export function useProject(slug: string) {
  return useQuery({
    queryKey: ['projects', slug],
    queryFn: () => projectApi.getBySlug(slug),
    enabled: !!slug,
  });
}

export function useUpdateProject(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, data }: { docId: string; data: Record<string, unknown> }) =>
      projectApi.update(docId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useAddMember(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectDocId, userDocId }: { projectDocId: string; userDocId: string }) =>
      projectApi.addMember(projectDocId, userDocId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}

export function useRemoveMember(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectDocId, userDocId }: { projectDocId: string; userDocId: string }) =>
      projectApi.removeMember(projectDocId, userDocId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}

export function useSearchUsers(search: string) {
  return useQuery({
    queryKey: ['users', search],
    queryFn: () => projectApi.searchUsers(search),
    enabled: search.length >= 2,
  });
}

export function useSetDefaultDevice(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectDocId, deviceDocId }: { projectDocId: string; deviceDocId: string | null }) =>
      projectApi.setDefaultDevice(projectDocId, deviceDocId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects', slug] });
    },
  });
}
