'use client';

import type { RecoveryStats } from '../../api';

interface RecoveryStatsBadgeProps {
  stats: RecoveryStats | null | undefined;
}

/**
 * Sessions-panel badge for ISS-197. Renders `"Failed Nx (a transient, b
 * timeout, …)"` only when `totalFailures > 0`; otherwise the component is
 * invisible. English-only copy per the project rule.
 */
export function RecoveryStatsBadge({ stats }: RecoveryStatsBadgeProps) {
  if (!stats || stats.totalFailures === 0) return null;

  const parts: string[] = [];
  if (stats.byKind.transient > 0) parts.push(`${stats.byKind.transient} transient`);
  if (stats.byKind.timeout > 0) parts.push(`${stats.byKind.timeout} timeout`);
  if (stats.byKind.permission > 0) parts.push(`${stats.byKind.permission} permission`);
  if (stats.byKind.permanent > 0) parts.push(`${stats.byKind.permanent} permanent`);
  const breakdown = parts.length > 0 ? ` (${parts.join(', ')})` : '';

  const title = [
    `Total failures: ${stats.totalFailures}`,
    `Last failure: ${stats.lastFailureKind} at ${new Date(stats.lastFailureAt).toLocaleString()}`,
    `Auto-retries used: ${stats.autoRetries}`,
  ].join('\n');

  return (
    <span
      title={title}
      className="shrink-0 rounded-full bg-danger-surface px-2 py-0.5 text-[10px] font-medium text-danger"
    >
      Failed {stats.totalFailures}x{breakdown}
    </span>
  );
}
