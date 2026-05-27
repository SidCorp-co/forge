'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { integrationKeys, integrationsApi } from '../api';
import type { CreateIntegrationInput, UpdateIntegrationInput } from '../types';

export function useIntegrations(projectId: string | null | undefined) {
  return useQuery({
    queryKey: projectId ? integrationKeys.list(projectId) : ['integrations', 'noop'],
    queryFn: () => integrationsApi.list(projectId as string),
    enabled: !!projectId,
  });
}

export function useIntegrationDeliveries(projectId: string, id: string | null) {
  return useQuery({
    queryKey: id ? integrationKeys.deliveries(projectId, id) : ['integrations', 'noop'],
    queryFn: () => integrationsApi.deliveries(projectId, id as string),
    enabled: !!id,
  });
}

export function useCreateIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateIntegrationInput) => integrationsApi.create(projectId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(projectId) }),
  });
}

export function useUpdateIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; body: UpdateIntegrationInput }) =>
      integrationsApi.update(projectId, vars.id, vars.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(projectId) }),
  });
}

export function useDeleteIntegration(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => integrationsApi.delete(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(projectId) }),
  });
}

export function useTestIntegration(projectId: string) {
  return useMutation({
    mutationFn: (id: string) => integrationsApi.test(projectId, id),
  });
}

export function useConfirmProdDeploy(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => integrationsApi.confirmProdDeploy(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(projectId) }),
  });
}

export function useRotateIntegrationSecret(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => integrationsApi.rotateSecret(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: integrationKeys.list(projectId) }),
  });
}
