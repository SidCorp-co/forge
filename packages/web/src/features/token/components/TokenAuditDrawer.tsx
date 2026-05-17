'use client';

import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { relativeTime } from '@/lib/utils/relative-time';
import { useTokenAudit } from '../hooks/use-tokens';

interface Props {
  tokenId: string | null;
  tokenName: string | null;
  onClose: () => void;
}

export function TokenAuditDrawer({ tokenId, tokenName, onClose }: Props) {
  const [limit, setLimit] = useState(50);
  const audit = useTokenAudit(tokenId, limit);

  if (!tokenId) return null;

  return (
    <div className="fixed inset-0 z-40 flex" aria-modal="true" role="dialog">
      <button
        type="button"
        aria-label="Close drawer"
        className="flex-1 bg-on-primary/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <aside className="flex h-full w-full max-w-md flex-col border-l border-outline-variant/30 bg-surface-container-low shadow-[0_0_30px_rgba(13,14,15,0.5)]">
        <header className="flex items-center justify-between border-b border-outline-variant/20 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-bold tracking-tight text-primary">
              {tokenName ?? 'Token activity'}
            </h2>
            <p className="text-[10px] uppercase tracking-widest text-outline">
              Audit log
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-sm text-outline hover:bg-surface-container-high hover:text-on-surface"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {audit.isLoading && (
            <div className="flex items-center gap-2 text-sm text-outline">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading audit entries…
            </div>
          )}
          {audit.error && (
            <p className="text-sm text-error">
              {(audit.error as Error).message}
            </p>
          )}
          {audit.data && audit.data.length === 0 && (
            <p className="text-sm text-outline">No recorded uses yet.</p>
          )}
          {audit.data && audit.data.length > 0 && (
            <ul className="space-y-3">
              {audit.data.map((entry) => (
                <li
                  key={entry.id}
                  className="rounded-sm border border-outline-variant/20 bg-surface-container-lowest p-3 text-[12px]"
                >
                  <div className="mb-1 flex items-center justify-between gap-3">
                    <span className="font-mono font-bold text-primary">
                      {entry.tool ?? '—'}
                      {entry.action ? `.${entry.action}` : ''}
                    </span>
                    <span className="text-[10px] text-outline">
                      {relativeTime(entry.createdAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-on-surface-variant">
                    {entry.resultCode && (
                      <span>
                        <span className="text-outline">result:</span> {entry.resultCode}
                      </span>
                    )}
                    {entry.projectId && (
                      <span className="font-mono">
                        <span className="text-outline">project:</span>{' '}
                        {entry.projectId.slice(0, 8)}
                      </span>
                    )}
                    {entry.ip && (
                      <span className="font-mono">
                        <span className="text-outline">ip:</span> {entry.ip}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {limit < 200 && audit.data && audit.data.length >= limit && (
          <footer className="border-t border-outline-variant/20 px-6 py-3">
            <button
              type="button"
              onClick={() => setLimit(200)}
              className="w-full rounded-sm border border-outline-variant/40 py-1.5 text-[11px] font-bold uppercase tracking-widest text-on-surface hover:bg-surface-container-high"
            >
              Load up to 200 entries
            </button>
          </footer>
        )}
      </aside>
    </div>
  );
}
