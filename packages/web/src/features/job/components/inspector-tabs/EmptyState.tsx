'use client';

import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  body: string;
  path?: string;
}

export function EmptyState({ title, body, path }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Inbox className="h-6 w-6 text-outline" aria-hidden="true" />
      <h4 className="text-sm font-semibold text-on-surface">{title}</h4>
      <p className="max-w-md text-xs text-on-surface-variant">{body}</p>
      {path && (
        <code
          data-testid="empty-state-path"
          className="mt-2 break-all rounded-sm bg-surface-container px-2 py-1 font-mono text-[11px] text-on-surface-variant"
        >
          {path}
        </code>
      )}
    </div>
  );
}
