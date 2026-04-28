import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  scheduleApi,
  type ScheduleCreatePayload,
  type ScheduleUpdatePayload,
} from '../api';

export function useSchedules(projectId: string | undefined) {
  return useQuery({
    queryKey: ['schedules', projectId],
    queryFn: () => scheduleApi.list(projectId!),
    enabled: !!projectId,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ScheduleCreatePayload) => scheduleApi.create(data),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: ScheduleUpdatePayload }) =>
      scheduleApi.update(id, data),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}

export function useDeleteSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => scheduleApi.delete(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}

export function useRunSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => scheduleApi.run(id),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}
