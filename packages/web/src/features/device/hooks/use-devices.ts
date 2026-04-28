'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceApi } from '../api';

export const deviceKeys = {
  mine: ['devices', 'mine'] as const,
};

export function useMyDevices() {
  return useQuery({
    queryKey: deviceKeys.mine,
    queryFn: deviceApi.listMine,
  });
}

export function useRenameDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      deviceApi.rename(id, name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deviceKeys.mine });
    },
  });
}

export function useRevokeDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string }) => deviceApi.revoke(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: deviceKeys.mine });
    },
  });
}

export function useMintPairingCode() {
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      deviceApi.mintPairingCode(projectId),
  });
}
