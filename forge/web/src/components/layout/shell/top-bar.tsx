'use client';

import { usePageTitle, usePageHeaderAction } from '@/hooks/use-page-title';
import { NotificationBell } from '@/features/notification/components/notification-bell';
import { NOTIFICATIONS_ENABLED } from '@/features/notification';
import { ENV_LABEL, HAS_ENV_LABEL, envLabelClasses } from '@/lib/env-label';

interface TopBarProps {
  onMenuOpen: () => void;
}

export function TopBar({ onMenuOpen }: TopBarProps) {
  const title = usePageTitle();
  const action = usePageHeaderAction();
  return (
    <div className="shrink-0 z-30 flex h-10 items-center gap-2 border-b border-surface-container-high bg-surface px-3">
      {HAS_ENV_LABEL && (
        <span
          className={`inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] ${envLabelClasses()}`}
          aria-label={`Environment: ${ENV_LABEL}`}
          title={`Environment: ${ENV_LABEL}`}
        >
          {ENV_LABEL}
        </span>
      )}
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{title}</h1>
      {action}
      {NOTIFICATIONS_ENABLED && <NotificationBell />}
      <button
        onClick={onMenuOpen}
        className="shrink-0 rounded-sm p-2 text-outline hover:text-on-surface hover:bg-surface-container-low transition-colors md:hidden"
        aria-label="Open menu"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
    </div>
  );
}
