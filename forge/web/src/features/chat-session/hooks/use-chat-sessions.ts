import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { chatSessionApi } from '../api';

const sessionsKey = (projectId: string | undefined) => ['chat-sessions', projectId] as const;
const sessionKey = (id: string | undefined | null) => ['chat-session', id] as const;

export function useChatSessions(projectId: string | undefined) {
  return useQuery({
    queryKey: sessionsKey(projectId),
    queryFn: () => chatSessionApi.list({ projectId: projectId as string }),
    enabled: !!projectId,
  });
}

export function useChatSession(id: string | null | undefined) {
  return useQuery({
    queryKey: sessionKey(id),
    queryFn: () => chatSessionApi.get(id as string),
    enabled: !!id,
  });
}

export function useCreateChatSession(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title?: string | null }) =>
      chatSessionApi.create({ projectId: projectId as string, ...input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sessionsKey(projectId) });
    },
  });
}

export function useSendChatMessage(sessionId: string | undefined, projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      chatSessionApi.sendMessage(sessionId as string, { content }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sessionKey(sessionId) });
      qc.invalidateQueries({ queryKey: sessionsKey(projectId) });
    },
  });
}

export function useDeleteChatSession(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => chatSessionApi.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: sessionsKey(projectId) });
    },
  });
}
