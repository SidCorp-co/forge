'use client';

import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import type {
  ProjectSkillSyncStatus,
  SkillDeviceStatus,
  SkillSyncSkillEntry,
} from '../types';

interface SkillSyncPanelProps {
  data: ProjectSkillSyncStatus | undefined;
  onSync: (skillName?: string) => void;
  syncing?: boolean;
  // Name of the skill currently being synced (null = a Sync-All is in flight).
  syncingSkill?: string | null;
  // Builds the cross-link to a device-centric page for a given deviceId.
  deviceHref: (deviceId: string) => string;
}

const STATUS_STYLES: Record<SkillDeviceStatus['status'], string> = {
  synced: 'border-success/30 bg-success-surface/40 text-success',
  outdated: 'border-warning/30 bg-warning-dim/10 text-warning',
  missing: 'border-outline-variant/40 bg-surface-container text-outline',
};

function statusLabel(d: SkillDeviceStatus, currentVersion: number): string {
  if (d.status === 'synced') return 'synced';
  if (d.status === 'missing') return 'missing';
  // outdated — show the installed → current version drift when known.
  const from = d.installedVersion != null ? `v${d.installedVersion}` : 'v?';
  return `outdated (${from}→v${currentVersion})`;
}

function DeviceBadge({
  skill,
  device,
  deviceName,
  deviceHref,
}: {
  skill: SkillSyncSkillEntry;
  device: SkillDeviceStatus;
  deviceName: string;
  deviceHref: (deviceId: string) => string;
}) {
  return (
    <Link
      href={deviceHref(device.deviceId)}
      title={`${deviceName} — ${statusLabel(device, skill.currentVersion)}`}
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] hover:opacity-80 ${STATUS_STYLES[device.status]}`}
    >
      <span className="font-medium">{deviceName}</span>
      <span className="opacity-80">{statusLabel(device, skill.currentVersion)}</span>
    </Link>
  );
}

export function SkillSyncPanel({
  data,
  onSync,
  syncing,
  syncingSkill,
  deviceHref,
}: SkillSyncPanelProps) {
  const devices = data?.devices ?? [];
  const skills = data?.skills ?? [];
  const deviceName = (id: string) =>
    devices.find((d) => d.deviceId === id)?.name ?? id.slice(0, 8);

  const hasDevices = devices.length > 0;
  const outdatedSkills = skills.filter((s) =>
    s.devices.some((d) => d.status !== 'synced'),
  ).length;
  const allInSync = hasDevices && outdatedSkills === 0;

  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Device Sync</h3>
          <p className="text-xs text-outline">
            {!hasDevices
              ? 'No devices bound to this project'
              : allInSync
                ? `All skills in sync across ${devices.length} device${devices.length !== 1 ? 's' : ''}`
                : `${outdatedSkills} skill${outdatedSkills !== 1 ? 's' : ''} out of sync on ${devices.length} device${devices.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        {hasDevices && (
          <button
            type="button"
            onClick={() => onSync()}
            disabled={syncing || allInSync}
            className="inline-flex items-center gap-1 rounded bg-on-primary px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${syncing && syncingSkill == null ? 'animate-spin' : ''}`}
            />
            {syncing && syncingSkill == null ? 'Syncing…' : 'Sync All'}
          </button>
        )}
      </div>

      {hasDevices && skills.length > 0 && (
        <div className="mt-3 space-y-2">
          {skills.map((skill) => {
            const skillSyncing = syncing && syncingSkill === skill.name;
            const skillOutdated = skill.devices.some((d) => d.status !== 'synced');
            return (
              <div
                key={skill.skillId}
                className="flex flex-col gap-2 rounded border border-outline-variant/20 bg-surface-container/40 px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs font-medium text-on-surface-variant">
                    {skill.name}
                  </span>
                  <span className="text-[10px] text-outline">v{skill.currentVersion}</span>
                  <div className="flex flex-wrap items-center gap-1">
                    {skill.devices.map((d) => (
                      <DeviceBadge
                        key={d.deviceId}
                        skill={skill}
                        device={d}
                        deviceName={deviceName(d.deviceId)}
                        deviceHref={deviceHref}
                      />
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onSync(skill.name)}
                  disabled={syncing || !skillOutdated}
                  title={skillOutdated ? 'Push this skill to bound devices' : 'In sync'}
                  className="inline-flex shrink-0 items-center gap-1 self-start rounded border border-outline-variant/30 px-2 py-0.5 text-[10px] text-on-surface hover:bg-surface-container disabled:opacity-40 sm:self-auto"
                >
                  <RefreshCw className={`h-3 w-3 ${skillSyncing ? 'animate-spin' : ''}`} />
                  {skillSyncing ? 'Syncing…' : 'Sync now'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
