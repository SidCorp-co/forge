'use client';

import { useConfigHealth } from '../hooks/use-config-health';
import { ConfigHealthBadge } from './config-health-badge';

interface Props {
  projectId: string;
  title: string;
  subtitle?: string;
}

export function SettingsHeader({ projectId, title, subtitle }: Props) {
  const health = useConfigHealth(projectId);

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-on-surface">{title}</h1>
        {subtitle && <p className="mt-1 text-xs text-outline">{subtitle}</p>}
      </div>
      <ConfigHealthBadge health={health} />
    </div>
  );
}
