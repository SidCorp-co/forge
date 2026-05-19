'use client';

import { useCallback } from 'react';
import type { MyDevice } from '@/features/device/types';
import { useBindRunner, useUnbindRunner, useUpdateProject } from './use-projects';
import type { ProjectDetail } from '../api/project-api';

export interface UseRunnerToggleArgs {
  projectId: string;
  project: ProjectDetail | undefined;
}

export interface UseRunnerToggleResult {
  /** Bind on / unbind off, auto-set defaultDeviceId on first bind. */
  toggle: (device: Pick<MyDevice, 'id'>) => Promise<void>;
  isPending: boolean;
}

/**
 * Shared bind/unbind logic for the Devices section and the wizard's Device
 * step. Centralises the auto-default-device write so both call sites behave
 * identically.
 */
export function useRunnerToggle({ projectId, project }: UseRunnerToggleArgs): UseRunnerToggleResult {
  const bindRunner = useBindRunner();
  const unbindRunner = useUnbindRunner();
  const updateProject = useUpdateProject();

  const toggle = useCallback(
    async (device: Pick<MyDevice, 'id'>) => {
      const pool = project?.devicePool ?? [];
      const existing = pool.find((p) => p.id === device.id);
      if (existing) {
        await unbindRunner.mutateAsync({ projectId, runnerId: existing.runnerId });
        return;
      }
      await bindRunner.mutateAsync({ projectId, body: { deviceId: device.id } });
      // Auto-set default device when this is the first binding. Don't clobber
      // an existing choice — the user may have set one manually already.
      if (!project?.defaultDeviceId) {
        await updateProject.mutateAsync({
          id: projectId,
          patch: { defaultDeviceId: device.id },
        });
      }
    },
    [projectId, project, bindRunner, unbindRunner, updateProject],
  );

  return {
    toggle,
    isPending: bindRunner.isPending || unbindRunner.isPending || updateProject.isPending,
  };
}
