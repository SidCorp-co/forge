'use client';

import { useMyDevices } from '@/features/device/hooks/use-devices';
import {
  useAddDeviceToPool,
  useProject,
  useRemoveDeviceFromPool,
  useUpdateProject,
} from '@/features/project/hooks/use-projects';

interface DevicesSectionProps {
  projectId: string;
  isOwner: boolean;
}

export function DevicesSection({ projectId, isOwner }: DevicesSectionProps) {
  const { data: project } = useProject(projectId);
  const { data: myDevices } = useMyDevices();
  const updateProject = useUpdateProject();
  const addToPool = useAddDeviceToPool();
  const removeFromPool = useRemoveDeviceFromPool();

  if (!isOwner) return null;

  const activeDevices = (myDevices ?? []).filter((d) => d.status !== 'revoked');
  const pool = project?.devicePool ?? [];
  const inPoolIds = new Set(pool.map((p) => p.id));

  const onSetDefault = (deviceId: string | null) => {
    void updateProject.mutateAsync({ id: projectId, patch: { defaultDeviceId: deviceId } });
  };

  const onTogglePool = async (deviceId: string, alreadyIn: boolean) => {
    if (alreadyIn) {
      await removeFromPool.mutateAsync({ projectId, deviceId });
    } else {
      await addToPool.mutateAsync({ projectId, deviceId });
    }
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
          Devices
        </h2>
        <span className="text-[9px] font-mono text-outline">DEV_CFG</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-8">
        <div>
          <label
            htmlFor="default-device"
            className="mb-1 block text-sm font-medium text-on-surface-variant"
          >
            Default device
          </label>
          <select
            id="default-device"
            value={project?.defaultDeviceId ?? ''}
            onChange={(e) => onSetDefault(e.target.value || null)}
            disabled={updateProject.isPending}
            className="w-full bg-transparent border-0 border-b border-outline/30 rounded-none py-3 text-sm text-on-surface focus:outline-none focus:border-b-primary"
          >
            <option value="">None</option>
            {activeDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} {d.lastSeenAt ? `(last seen ${new Date(d.lastSeenAt).toLocaleDateString()})` : ''}
              </option>
            ))}
          </select>
          <p className="mt-2 text-[10px] text-outline">
            Selected when no pool device is available. Changes save immediately.
          </p>
        </div>

        <div>
          <p className="mb-3 text-sm font-medium text-on-surface-variant">Device pool</p>
          <p className="mb-4 text-[10px] text-outline">
            Pool devices run pipeline steps in parallel. The dispatcher picks any free pool
            device before falling back to the default.
          </p>

          {activeDevices.length === 0 ? (
            <p className="text-[10px] text-outline">
              No active devices. Pair one on the <span className="font-medium">/devices</span>{' '}
              page first.
            </p>
          ) : (
            <div className="space-y-2">
              {activeDevices.map((d) => {
                const inPool = inPoolIds.has(d.id);
                return (
                  <div
                    key={d.id}
                    className="flex items-center justify-between border border-outline-variant/20 px-3 py-2"
                  >
                    <span className="text-sm text-on-surface-variant">
                      {d.name}{' '}
                      <span className="text-[10px] text-outline">({d.platform})</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void onTogglePool(d.id, inPool)}
                      disabled={addToPool.isPending || removeFromPool.isPending}
                      className={`px-2 py-0.5 text-xs font-medium rounded-sm disabled:opacity-50 ${
                        inPool
                          ? 'bg-info-surface/30 text-info hover:bg-info-surface/50'
                          : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-variant'
                      }`}
                    >
                      {inPool ? 'In Pool' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
