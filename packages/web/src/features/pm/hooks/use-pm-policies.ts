'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { pmApi } from '../api/pm-api';
import type { PmPolicyCreate, PmPolicyPatch } from '../types';

export const pmPoliciesKey = (projectId: string | undefined) =>
  ['pm', 'policies', projectId] as const;

export function usePmPolicies(projectId: string | undefined) {
  return useQuery({
    queryKey: pmPoliciesKey(projectId),
    queryFn: () => pmApi.listPolicies(projectId as string),
    enabled: !!projectId,
  });
}

export function useCreatePmPolicy(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PmPolicyCreate) =>
      pmApi.createPolicy(projectId as string, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: pmPoliciesKey(projectId) }),
  });
}

export function useUpdatePmPolicy(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PmPolicyPatch }) =>
      pmApi.updatePolicy(projectId as string, id, patch),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: pmPoliciesKey(projectId) }),
  });
}

export function useDeletePmPolicy(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => pmApi.deletePolicy(projectId as string, id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: pmPoliciesKey(projectId) }),
  });
}
