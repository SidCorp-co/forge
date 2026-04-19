import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { deviceApi } from './api';

export function useDevices() {
  return useQuery({
    queryKey: ['devices'],
    queryFn: () => deviceApi.getDevices(),
  });
}

export function useUpdateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ docId, data }: { docId: string; data: Record<string, unknown> }) =>
      deviceApi.updateDevice(docId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (docId: string) => deviceApi.deleteDevice(docId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['devices'] });
    },
  });
}
