'use client';

import { Clock, Hash } from 'lucide-react';
import type { ChangelogEntry } from '../types';

interface SkillHistoryProps {
  changelog: ChangelogEntry[];
  currentVersion: string;
}

export function SkillHistory({ changelog, currentVersion }: SkillHistoryProps) {
  if (!changelog.length) {
    return (
      <p className="text-xs text-outline">No version history available.</p>
    );
  }

  const sorted = [...changelog].reverse();

  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold text-on-surface-variant">Version History</h4>
      <div className="space-y-1">
        {sorted.map((entry, i) => (
          <div
            key={`${entry.version}-${entry.timestamp}`}
            className={`flex items-start gap-2 rounded border px-3 py-2 ${
              i === 0 ? 'border-success/30 bg-success-surface' : 'border-outline-variant/20 bg-surface-container-low'
            }`}
          >
            <div className="mt-0.5">
              {i === 0 ? (
                <div className="h-2 w-2 rounded-full bg-success" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-surface-variant" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-on-surface-variant">v{entry.version}</span>
                {i === 0 && (
                  <span className="rounded bg-success-surface px-1 text-[10px] text-success">current</span>
                )}
              </div>
              <p className="text-xs text-primary-fixed">{entry.summary}</p>
              <div className="mt-0.5 flex items-center gap-3 text-[10px] text-outline">
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {new Date(entry.timestamp).toLocaleString()}
                </span>
                <span className="inline-flex items-center gap-0.5">
                  <Hash className="h-2.5 w-2.5" />
                  {entry.hash.slice(0, 8)}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
