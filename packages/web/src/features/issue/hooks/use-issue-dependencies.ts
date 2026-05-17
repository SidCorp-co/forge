'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AddDependencyInput,
  type DecomposeRequest,
  issueApi,
} from '../api/issue-api';
import { issueKeys } from './use-issues';

export const dependencyKey = (issueId: string | undefined) =>
  ['issue', issueId, 'dependencies'] as const;

export function useIssueDependencies(issueId: string | undefined) {
  return useQuery({
    queryKey: dependencyKey(issueId),
    queryFn: () => issueApi.getDependencies(issueId as string),
    enabled: !!issueId,
    staleTime: 15_000,
  });
}

export function useAddDependency(issueId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: AddDependencyInput) =>
      issueApi.addDependency(issueId as string, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dependencyKey(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.detail(issueId) });
    },
  });
}

export function useDeleteDependency(issueId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edgeId: string) =>
      issueApi.deleteDependency(issueId as string, edgeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dependencyKey(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.detail(issueId) });
    },
  });
}

export function useDecomposeIssue(issueId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DecomposeRequest) =>
      issueApi.decompose(issueId as string, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: dependencyKey(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.detail(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.lists });
      qc.invalidateQueries({ queryKey: issueKeys.searches });
    },
  });
}
