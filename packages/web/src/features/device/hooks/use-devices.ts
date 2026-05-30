'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceApi } from '../api';

export const deviceKeys = {
  mine: ['devices', 'mine'] as const,
  runners: (deviceId: string) => ['devices', deviceId, 'runners'] as const,
};

export function useMyDevices() {
  return useQuery({
    queryKey: deviceKeys.mine,
    queryFn: deviceApi.listMine,
  });
}

/**
 * ISS-273 — projects assigned to a device the caller owns, with each runner's
 * per-device repo path/branch and online/offline status.
 */
export function useDeviceRunners(deviceId: string | undefined) {
  return useQuery({
    queryKey: deviceKeys.runners(deviceId ?? ''),
    queryFn: () => deviceApi.listRunners(deviceId as string),
    enabled: !!deviceId,
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
