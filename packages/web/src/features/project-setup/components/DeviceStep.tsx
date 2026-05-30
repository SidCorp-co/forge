'use client';

import { Check, Copy } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useMyDevices } from '@/features/device/hooks/use-devices';
import type { MyDevice } from '@/features/device/types';
import { usePatchRunner, useProject } from '@/features/project/hooks/use-projects';
import { useRunnerToggle } from '@/features/project/hooks/use-runner-toggle';
import type { ProjectDetail } from '@/features/project/api/project-api';

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
        device toggled on becomes the default. Set the repo path on each device
        so the runner knows where to check the project out.
      </p>

      <div className="space-y-2">
        {activeDevices.map((d) => {
          const inUse = poolIds.has(d.id);
          return (
            <div
              key={d.id}
              className="border border-outline-variant/20"
            >
              <label className="flex items-center justify-between gap-3 px-3 py-2 cursor-pointer">
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
              {inUse && project && (
                <DeviceBindDetails device={d} projectId={projectId} project={project} />
              )}
            </div>
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

/**
 * Per-device path input + copyable `forge-runner bind` command, shown once a
 * device is bound. Lets web users set the repo path inline and gives
 * terminal-first users the equivalent CLI command.
 */
function DeviceBindDetails({
  device,
  projectId,
  project,
}: {
  device: MyDevice;
  projectId: string;
  project: ProjectDetail;
}) {
  const runner = project.devicePool.find((p) => p.id === device.id);
  const patchRunner = usePatchRunner();
  const [path, setPath] = useState(project.repoPath ?? '');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const command = `forge-runner bind ${project.slug} --path ${path.trim() || '<dir>'}`;

  const onSave = async () => {
    if (!runner) return;
    setSaved(false);
    await patchRunner.mutateAsync({
      projectId,
      runnerId: runner.runnerId,
      body: { repoPath: path.trim() || null },
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const onCopy = () => {
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="border-t border-outline-variant/20 px-3 py-3 space-y-3 bg-surface-container-low/40">
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-[10px] uppercase tracking-wider text-outline">
            Repo path on this device
          </span>
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={project.repoPath ?? '/absolute/path/on/this/device'}
            spellCheck={false}
            className="w-full bg-transparent border-0 border-b border-outline/30 py-1 text-sm text-on-surface placeholder:text-outline/40 focus:outline-none focus:border-b-primary"
          />
        </label>
        <div className="flex items-center gap-2 pb-1">
          {saved && (
            <span className="inline-flex items-center gap-1 text-[10px] text-success">
              <Check className="h-3 w-3" /> Saved
            </span>
          )}
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!runner || patchRunner.isPending}
            className="bg-primary text-on-primary px-3 py-1.5 text-xs rounded-sm disabled:opacity-50"
          >
            {patchRunner.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
      <div>
        <span className="mb-1 block text-[10px] uppercase tracking-wider text-outline">
          Or bind from a terminal
        </span>
        <div className="flex items-center gap-2 rounded-sm border border-outline-variant/30 bg-surface-container-high px-3 py-2">
          <code className="flex-1 font-mono text-xs text-on-surface break-all">{command}</code>
          <button
            type="button"
            onClick={onCopy}
            className="text-on-surface-variant hover:text-on-surface"
            aria-label="Copy command"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
