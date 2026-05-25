'use client';

import type { JobDetailResponse } from '../../api/job-api';
import { EmptyState } from './EmptyState';

interface TimingTabProps {
  job: JobDetailResponse | undefined;
}

interface Row {
  label: string;
  ts: string | null | undefined;
}

export function TimingTab({ job }: TimingTabProps) {
  if (!job) {
    return <EmptyState title="No job detail" body="Job metadata is unavailable." />;
  }

  const rows: Row[] = [
    { label: 'dispatched', ts: job.queuedAt as unknown as string | null | undefined },
    { label: 'first turn', ts: job.dispatchedAt as unknown as string | null | undefined },
    { label: 'exit', ts: job.finishedAt as unknown as string | null | undefined },
  ];

  const visible = rows.filter((r) => !!r.ts);

  if (visible.length === 0) {
    return <EmptyState title="No timestamps" body="This job has no recorded lifecycle events." />;
  }

  return (
    <table className="w-full border-collapse px-4 py-3 text-xs">
      <thead>
        <tr className="border-b border-outline-variant/20 text-left text-on-surface-variant">
          <th className="py-1 pr-2 font-medium">stage</th>
          <th className="py-1 font-medium">timestamp</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((r) => (
          <tr key={r.label} className="border-b border-outline-variant/10">
            <td className="py-1 pr-2 text-on-surface">{r.label}</td>
            <td className="py-1 font-mono text-on-surface">
              <time dateTime={r.ts as string}>
                {new Date(r.ts as string).toLocaleString()}
              </time>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
