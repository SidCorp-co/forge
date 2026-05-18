'use client';

import { Loader2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '@forge/contracts';
import { relativeTime } from '@/lib/utils/relative-time';
import type { Pat } from '../types';

interface Props {
  token: Pat;
  projects: Project[];
  onRevoke: () => Promise<void>;
  onOpenAudit: () => void;
}

function expiresLabel(expiresAt: string | null): string {
  if (!expiresAt) return 'Never';
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Expired';
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days < 30) return `in ${days}d`;
  if (days < 365) return `in ${Math.round(days / 30)}mo`;
  return `in ${Math.round(days / 365)}y`;
}

export function TokenRow({ token, projects, onRevoke, onOpenAudit }: Props) {
  const [revoking, setRevoking] = useState(false);

  const hasAdmin = token.scopes.includes('admin');
  const scopeSummary = hasAdmin
    ? 'admin'
    : token.scopes.includes('write')
      ? 'read+write'
      : 'read';
  const projectBadges =
    token.projectIds === null || token.projectIds.length === 0
      ? null
      : token.projectIds
          .map((id) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 6))
          .slice(0, 3);
  const projectOverflow =
    token.projectIds && token.projectIds.length > 3
      ? token.projectIds.length - 3
      : 0;

  async function revoke(e: React.MouseEvent) {
    e.stopPropagation();
    if (revoking) return;
    if (!window.confirm(`Revoke "${token.name}"? Active sessions using it will be terminated.`)) {
      return;
    }
    setRevoking(true);
    try {
      await onRevoke();
    } finally {
      setRevoking(false);
    }
  }

  function handleRowKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpenAudit();
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenAudit}
      onKeyDown={handleRowKey}
      className="grid w-full grid-cols-12 cursor-pointer items-center gap-3 border-b border-outline-variant/10 px-6 py-4 text-left transition-colors hover:bg-surface-container-low focus:outline-none focus-visible:bg-surface-container-low"
    >
      <div className="col-span-12 min-w-0 md:col-span-3">
        <p className="truncate text-sm font-bold text-on-surface">{token.name}</p>
        <p className="font-mono text-[10px] text-outline">
          forge_pat_live_{token.prefix}…
        </p>
      </div>
      <div className="col-span-6 md:col-span-2">
        <span
          className={`inline-flex rounded-sm px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${
            hasAdmin
              ? 'bg-error/15 text-error'
              : 'bg-surface-container-highest text-primary'
          }`}
          title={hasAdmin ? 'Grants cross-tenant admin tools (forge_admin_*)' : undefined}
        >
          {scopeSummary}
        </span>
      </div>
      <div className="col-span-6 flex flex-wrap gap-1 md:col-span-3">
        {projectBadges === null ? (
          <span className="rounded-sm bg-surface-container-high px-2 py-0.5 text-[10px] uppercase tracking-widest text-outline">
            All projects
          </span>
        ) : (
          <>
            {projectBadges.map((label) => (
              <span
                key={label}
                className="rounded-sm bg-surface-container-high px-2 py-0.5 text-[10px] tracking-wider text-on-surface-variant"
              >
                {label}
              </span>
            ))}
            {projectOverflow > 0 && (
              <span className="rounded-sm bg-surface-container-high px-2 py-0.5 text-[10px] text-outline">
                +{projectOverflow}
              </span>
            )}
          </>
        )}
      </div>
      <div className="col-span-6 md:col-span-2">
        {token.lastUsedAt ? (
          <div className="text-[11px] text-on-surface-variant">
            <p>{relativeTime(token.lastUsedAt)}</p>
            {token.lastUsedIp && (
              <p className="font-mono text-[10px] text-outline">{token.lastUsedIp}</p>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-outline">Never used</p>
        )}
      </div>
      <div className="col-span-4 md:col-span-1 text-[11px] text-on-surface-variant">
        {expiresLabel(token.expiresAt)}
      </div>
      <div className="col-span-2 flex justify-end md:col-span-1">
        <button
          type="button"
          onClick={revoke}
          disabled={revoking}
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-outline hover:bg-error/10 hover:text-error disabled:opacity-40"
          aria-label="Revoke token"
        >
          {revoking ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
