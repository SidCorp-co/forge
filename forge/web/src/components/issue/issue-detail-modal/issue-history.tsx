'use client';

import { HistoryBadge } from './history-badge';

interface HistoryEntry {
  at: string;
  by: string;
  field: string;
  from: string | null;
  to: string | null;
}

interface IssueHistoryProps {
  history: HistoryEntry[];
}

export function IssueHistory({ history }: IssueHistoryProps) {
  if (!history || history.length === 0) return null;

  return (
    <div className="px-4 py-4 sm:px-6">
      <h3 className="mb-2 text-sm font-semibold">History</h3>
      <ul className="space-y-1">
        {history.map((entry, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-1.5 text-xs text-primary-fixed">
            <span className="shrink-0 text-[10px] text-outline">{new Date(entry.at).toLocaleString()}</span>
            <span className="break-all">
              <span className="font-medium text-on-surface-variant">{entry.by}</span>
              {' changed '}
              <span className="font-medium">{entry.field}</span>
              {' from '}
              <HistoryBadge field={entry.field} value={entry.from} />
              {' to '}
              <HistoryBadge field={entry.field} value={entry.to} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
