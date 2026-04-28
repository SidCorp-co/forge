import { useQuery } from '@tanstack/react-query';
import { chatLogApi } from './api';
import type { ChatLogFilters } from './types';

export function useChatLogs(filters: ChatLogFilters = {}) {
  return useQuery({
    queryKey: ['chat-logs', filters],
    queryFn: () => chatLogApi.getAll(filters),
    staleTime: 30_000,
  });
}

export function useChatLog(id: string) {
  return useQuery({
    queryKey: ['chat-log', id],
    queryFn: () => chatLogApi.getById(id),
    enabled: !!id,
  });
}
