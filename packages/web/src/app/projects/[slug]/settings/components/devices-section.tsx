'use client';

import Link from 'next/link';
import { useMyDevices } from '@/features/device/hooks/use-devices';
import { useProject, useUpdateProject } from '@/features/project/hooks/use-projects';
import { useRunnerToggle } from '@/features/project/hooks/use-runner-toggle';

interface DevicesSectionProps {
  projectId: string;
  isOwner: boolean;
}

type DeviceUsage = 'online' | 'offline' | 'not-in-use';

function relativeLastSeen(iso: string | Date | null): string {
  if (!iso) return 'never';
  const then = (typeof iso === 'string' ? new Date(iso) : iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function DevicesSection({ projectId, isOwner }: DevicesSectionProps) {
  const { data: project } = useProject(projectId);
  const { data: myDevices } = useMyDevices();
  const updateProject = useUpdateProject();
  const { toggle, isPending } = useRunnerToggle({ projectId, project });

  const activeDevices = (myDevices ?? []).filter((d) => d.status !== 'revoked');
  const poolById = new Map(
    (project?.devicePool ?? []).map((p) => [p.id, p]),
  );

  const onSetDefault = (deviceId: string) => {
    if (!isOwner) return;
    void updateProject.mutateAsync({ id: projectId, patch: { defaultDeviceId: deviceId } });
  };

  return (
    <section className="space-y-6">
      <div className="flex justify-between items-end border-b border-outline-variant/10 pb-2">
        <div className="flex items-center gap-3">
          <h2 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant font-bold">
            Devices assigned to this project
          </h2>
          {!isOwner && (
            <span className="rounded-sm border border-outline-variant/30 px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest text-outline">
              Owner only
            </span>
          )}
        </div>
        <span className="text-[9px] font-mono text-outline">IDN_DEV</span>
      </div>

      <div className="bg-surface-container-low border border-outline-variant/30 p-8 space-y-4">
        <p className="text-[10px] text-outline">
          Toggle a paired device on to use it as a runner for this project. The
          first device you toggle on becomes the default; switch later with the
          radio.
        </p>

        {activeDevices.length === 0 ? (
          <p className="text-[10px] text-outline">
            No paired devices.{' '}
            <Link href="/settings/devices" className="underline text-primary">
              Pair one on the Devices page
            </Link>{' '}
            first.
          </p>
        ) : (
          <div className="space-y-2">
            {activeDevices.map((d) => {
              const poolEntry = poolById.get(d.id);
              const inUse = !!poolEntry;
              const isDefault = project?.defaultDeviceId === d.id;
              const usage: DeviceUsage = inUse
                ? d.status === 'online'
                  ? 'online'
                  : 'offline'
                : 'not-in-use';
              const pillCls =
                usage === 'online'
                  ? 'bg-success-surface/30 text-success'
                  : usage === 'offline'
                    ? 'bg-surface-variant text-on-surface-variant'
                    : 'bg-warning-surface/30 text-warning';
              const pillText =
                usage === 'online' ? 'Online' : usage === 'offline' ? 'Offline' : 'Not in use';
              return (
                <div
                  key={d.id}
                  className="flex items-center justify-between border border-outline-variant/20 px-3 py-2 gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-on-surface">
                      <span className="font-medium truncate">{d.name}</span>
                      <span
                        className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${pillCls}`}
                      >
                        {pillText}
                      </span>
                    </div>
                    <div className="text-[10px] text-outline mt-0.5">
                      {d.platform} · last seen {relativeLastSeen(d.lastSeenAt ?? null)}
                    </div>
                  </div>

                  {inUse && (
                    <label className="flex items-center gap-1.5 text-[10px] text-on-surface-variant cursor-pointer">
                      <input
                        type="radio"
                        name="default-device"
                        checked={isDefault}
                        onChange={() => onSetDefault(d.id)}
                        disabled={!isOwner || updateProject.isPending}
                        className="accent-primary"
                      />
                      Default
                    </label>
                  )}

                  <button
                    type="button"
                    onClick={() => void toggle(d)}
                    disabled={!isOwner || isPending}
                    className={`px-2 py-0.5 text-xs font-medium rounded-sm disabled:opacity-50 ${
                      inUse
                        ? 'bg-primary text-on-primary hover:bg-primary/90'
                        : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-variant'
                    }`}
                    aria-pressed={inUse}
                  >
                    {inUse ? 'In use' : 'Use'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
