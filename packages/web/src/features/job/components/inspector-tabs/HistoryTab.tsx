'use client';

import { EmptyState } from './EmptyState';

export function HistoryTab() {
  return (
    <div className="space-y-2">
      <EmptyState title="History" body="Ships in W2.1.4 (ISS-202)." />
      <p className="px-6 text-center text-[11px] text-outline">
        See <code className="font-mono">docs/proposals/pipeline-wave-2.md</code> for the full plan.
      </p>
    </div>
  );
}
