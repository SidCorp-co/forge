import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { scheduleApi, type ScheduleFormData } from '../api';

export function useSchedules(projectSlug: string | undefined) {
  return useQuery({
    queryKey: ['schedules', projectSlug],
    queryFn: () => scheduleApi.getAll(projectSlug!),
    enabled: !!projectSlug,
  });
}

export function useCreateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: ScheduleFormData) => scheduleApi.create(data),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules'] });
    },
  });
}

export function useUpdateSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ScheduleFormData> }) =>
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
