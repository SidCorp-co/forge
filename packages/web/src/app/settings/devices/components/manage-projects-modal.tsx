'use client';

import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui';
import type { MyDevice } from '@/features/device/types';
import { useMeProfile } from '@/features/me/hooks/use-me';
import {
  projectKeys,
  useBindRunner,
  useProjects,
  useUnbindRunner,
} from '@/features/project/hooks/use-projects';
import { projectApi, type ProjectDetail } from '@/features/project/api/project-api';

interface Props {
  device: MyDevice;
  open: boolean;
  onClose: () => void;
}

export function ManageProjectsModal({ device, open, onClose }: Props) {
  const { data: projects } = useProjects();
  const me = useMeProfile();
  const qc = useQueryClient();
  const bindRunner = useBindRunner();
  const unbindRunner = useUnbindRunner();

  const owned = useMemo(
    () => (projects ?? []).filter((p) => me.data && p.ownerId === me.data.id),
    [projects, me.data],
  );

  // Fetch each owned project's detail in parallel — needed so we can read
  // `devicePool` and tell whether THIS device is already bound.
  const detailQueries = useQueries({
    queries: owned.map((p) => ({
      queryKey: projectKeys.detail(p.id),
      queryFn: () => projectApi.getById(p.id),
      enabled: open,
    })),
  });

  const detailById = useMemo(() => {
    const map = new Map<string, ProjectDetail>();
    owned.forEach((p, i) => {
      const data = detailQueries[i]?.data;
      if (data) map.set(p.id, data);
    });
    return map;
  }, [owned, detailQueries]);

  const initialChecked = useMemo(() => {
    const s = new Set<string>();
    for (const [projectId, detail] of detailById) {
      if (detail.devicePool.some((d) => d.id === device.id)) s.add(projectId);
    }
    return s;
  }, [detailById, device.id]);

  const [checked, setChecked] = useState<Set<string>>(initialChecked);
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState<Array<{ projectName: string; message: string }>>([]);

  // Re-seed `checked` whenever the modal opens or the detail set changes —
  // useState only runs its initialiser once, so without this the checkboxes
  // would never match the freshly-fetched server state.
  const initialSig = useMemo(() => {
    return Array.from(initialChecked).sort().join(',');
  }, [initialChecked]);
  const [seededSig, setSeededSig] = useState<string | null>(null);
  if (open && seededSig !== initialSig) {
    setChecked(new Set(initialChecked));
    setSeededSig(initialSig);
  }
  if (!open && seededSig !== null) {
    setSeededSig(null);
  }

  const onToggle = (projectId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const onSave = async () => {
    setIsSaving(true);
    setErrors([]);
    const tasks: Array<Promise<{ projectName: string; ok: boolean; message?: string }>> = [];
    for (const p of owned) {
      const detail = detailById.get(p.id);
      const isCurrentlyBound = detail?.devicePool.some((d) => d.id === device.id) ?? false;
      const shouldBind = checked.has(p.id);
      if (shouldBind === isCurrentlyBound) continue;
      if (shouldBind) {
        tasks.push(
          bindRunner
            .mutateAsync({ projectId: p.id, body: { deviceId: device.id } })
            .then(() => ({ projectName: p.name, ok: true }))
            .catch((e: unknown) => ({
              projectName: p.name,
              ok: false,
              message: e instanceof Error ? e.message : 'failed',
            })),
        );
      } else {
        const runner = detail?.devicePool.find((d) => d.id === device.id);
        if (!runner) continue;
        tasks.push(
          unbindRunner
            .mutateAsync({ projectId: p.id, runnerId: runner.runnerId })
            .then(() => ({ projectName: p.name, ok: true }))
            .catch((e: unknown) => ({
              projectName: p.name,
              ok: false,
              message: e instanceof Error ? e.message : 'failed',
            })),
        );
      }
    }
    const results = await Promise.all(tasks);
    const failed = results.filter((r) => !r.ok);
    await qc.invalidateQueries({ queryKey: projectKeys.all });
    setIsSaving(false);
    if (failed.length === 0) {
      onClose();
      return;
    }
    setErrors(failed.map((r) => ({ projectName: r.projectName, message: r.message ?? 'failed' })));
  };

  const anyLoading = detailQueries.some((q) => q.isLoading);

  return (
    <Modal open={open} onClose={onClose}>
      <div className="p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-on-surface">Manage projects</h2>
          <p className="mt-1 text-xs text-outline">
            Choose which projects can run agents on <strong>{device.name}</strong>.
          </p>
        </div>

        {anyLoading && <p className="text-xs text-outline">Loading project details…</p>}

        {!anyLoading && owned.length === 0 && (
          <p className="text-sm text-on-surface-variant">
            You don&apos;t own any projects yet. Create one first.
          </p>
        )}

        {owned.length > 0 && (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {owned.map((p) => {
              const detail = detailById.get(p.id);
              const isBound = detail?.devicePool.some((d) => d.id === device.id) ?? false;
              const isChecked = checked.has(p.id);
              return (
                <label
                  key={p.id}
                  className="flex items-center gap-3 border border-outline-variant/20 px-3 py-2 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => onToggle(p.id)}
                    className="accent-primary h-4 w-4"
                  />
                  <span className="flex-1 text-sm text-on-surface">{p.name}</span>
                  {isBound && (
                    <span className="text-[10px] uppercase tracking-wider text-success">
                      Currently bound
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        {errors.length > 0 && (
          <div className="border border-error/40 bg-error-surface/30 p-3 text-xs text-error space-y-1">
            <p className="font-medium">Some changes failed:</p>
            {errors.map((e) => (
              <p key={e.projectName}>
                {e.projectName}: {e.message}
              </p>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="text-sm text-on-surface-variant px-3 py-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={isSaving || anyLoading}
            className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
