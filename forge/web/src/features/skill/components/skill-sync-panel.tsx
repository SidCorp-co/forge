'use client';

import { RefreshCw, AlertCircle } from 'lucide-react';
import type { SkillSyncStatus } from '../types';

interface SkillSyncPanelProps {
  syncStatuses: SkillSyncStatus[];
  onSyncAll: () => void;
  syncing?: boolean;
}

export function SkillSyncPanel({ syncStatuses, onSyncAll, syncing }: SkillSyncPanelProps) {
  const hasDevices = syncStatuses.some((s) => (s.devices ?? []).length > 0);
  const allInSync = syncStatuses.every((s) =>
    (s.devices ?? []).every((d) => d.inSync)
  );
  const outdatedCount = syncStatuses.filter((s) =>
    (s.devices ?? []).some((d) => !d.inSync)
  ).length;

  return (
    <div className="rounded-lg border border-outline-variant/30 bg-surface-container-low p-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-on-surface">Device Sync</h3>
          <p className="text-xs text-outline">
            {!hasDevices
              ? 'No devices connected'
              : allInSync
                ? 'All skills in sync'
                : `${outdatedCount} skill${outdatedCount !== 1 ? 's' : ''} outdated`}
          </p>
        </div>
        {hasDevices && (
          <button
            onClick={onSyncAll}
            disabled={syncing || allInSync}
            className="inline-flex items-center gap-1 rounded bg-on-primary px-3 py-1.5 text-xs text-on-surface hover:bg-surface-container disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing...' : 'Sync All'}
          </button>
        )}
      </div>

      {hasDevices && !allInSync && (
        <div className="mt-3 space-y-1">
          {syncStatuses
            .filter((s) => (s.devices ?? []).some((d) => !d.inSync))
            .map((s) => (
              <div key={s.skillName} className="flex items-center justify-between rounded border border-warning/20 bg-warning-dim/10 px-2 py-1">
                <span className="text-xs text-on-surface-variant">{s.skillName}</span>
                <div className="flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 text-warning" />
                  <span className="text-[10px] text-warning">v{s.currentVersion} outdated</span>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
