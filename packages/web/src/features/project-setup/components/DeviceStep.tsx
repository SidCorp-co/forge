'use client';

import Link from 'next/link';
import { useMyDevices } from '@/features/device/hooks/use-devices';
import { useProject } from '@/features/project/hooks/use-projects';
import { useRunnerToggle } from '@/features/project/hooks/use-runner-toggle';

interface Props {
  projectId: string;
  onSaved: () => void;
}

export function DeviceStep({ projectId, onSaved }: Props) {
  const { data: project } = useProject(projectId);
  const { data: myDevices } = useMyDevices();
  const { toggle, isPending } = useRunnerToggle({ projectId, project });

  const activeDevices = (myDevices ?? []).filter((d) => d.status !== 'revoked');
  const poolIds = new Set((project?.devicePool ?? []).map((p) => p.id));

  if (activeDevices.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-on-surface-variant">
          You haven&apos;t paired a device yet. Pair one now, then come back to bind it.
        </p>
        <div className="flex gap-3">
          <Link
            href="/settings/devices"
            target="_blank"
            rel="noopener noreferrer"
            className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm"
          >
            Pair your first device
          </Link>
          <button
            type="button"
            onClick={onSaved}
            className="border border-outline/30 px-4 py-2 text-sm rounded-sm"
          >
            Skip — I&apos;ll set this up later
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-on-surface-variant">
        Tick the devices that should run agents for this project. The first
        device toggled on becomes the default.
      </p>

      <div className="space-y-2">
        {activeDevices.map((d) => {
          const inUse = poolIds.has(d.id);
          return (
            <label
              key={d.id}
              className="flex items-center justify-between gap-3 border border-outline-variant/20 px-3 py-2 cursor-pointer"
            >
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={inUse}
                  onChange={() => void toggle(d)}
                  disabled={isPending}
                  className="accent-primary h-4 w-4"
                />
                <span className="text-sm text-on-surface">
                  {d.name}{' '}
                  <span className="text-[10px] text-outline">({d.platform})</span>
                </span>
              </span>
              <span
                className={`text-[10px] font-mono uppercase ${
                  d.status === 'online' ? 'text-success' : 'text-outline'
                }`}
              >
                {d.status === 'online' ? 'Online' : 'Offline'}
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onSaved}
          className="bg-primary text-on-primary px-4 py-2 text-sm rounded-sm"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
