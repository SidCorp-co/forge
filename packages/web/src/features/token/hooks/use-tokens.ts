'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tokenApi } from '../api';
import type { CreatePatInput } from '../types';

/**
 * Query key shape — `src/lib/ws/event-router.ts` invalidates `['tokens']` on
 * every `pat.*` event. Keep both sides in lockstep when renaming.
 */
export const tokenKeys = {
  all: ['tokens'] as const,
  audit: (id: string) => ['tokens', 'audit', id] as const,
};

export function useTokens() {
  return useQuery({
    queryKey: tokenKeys.all,
    queryFn: tokenApi.list,
  });
}

export function useCreateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePatInput) => tokenApi.create(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tokenKeys.all });
    },
  });
}

export function useRevokeToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => tokenApi.revoke(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tokenKeys.all });
    },
  });
}

export function useTokenAudit(id: string | null, limit: number) {
  return useQuery({
    queryKey: id ? [...tokenKeys.audit(id), limit] : ['tokens', 'audit', 'none'],
    queryFn: () => tokenApi.audit(id as string, limit),
    enabled: !!id,
  });
}

export function useRotateToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, expiresAt }: { id: string; expiresAt?: string | null }) =>
      tokenApi.rotate(id, expiresAt ?? null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tokenKeys.all });
    },
  });
}
