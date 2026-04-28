import { keepPreviousData, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { chatLogApi } from '../api';
import type { ChatLogFilters } from '../types';

export function useChatLogs(filters: ChatLogFilters = {}) {
  return useQuery({
    queryKey: ['chat-logs', filters],
    queryFn: () => chatLogApi.getAll(filters),
    placeholderData: keepPreviousData,
  });
}

export function useChatLog(id: string | null) {
  return useQuery({
    queryKey: ['chat-log', id],
    queryFn: () => chatLogApi.getById(id!),
    enabled: !!id,
  });
}

export function useUpdateChatLogRating() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, qaRating, qaNotes }: { id: string; qaRating: string | null; qaNotes?: string }) =>
      chatLogApi.updateRating(id, qaRating, qaNotes),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['chat-logs'] });
      queryClient.invalidateQueries({ queryKey: ['chat-log'] });
    },
  });
}
