'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export type IssueDetailTabKey = 'overview' | 'plan' | 'activity' | 'files';

export interface IssueDetailTabsProps {
  active: IssueDetailTabKey;
  onChange: (next: IssueDetailTabKey) => void;
  overview: ReactNode;
  plan: ReactNode;
  activity: ReactNode;
  files: ReactNode;
}

const TAB_ORDER: ReadonlyArray<{ key: IssueDetailTabKey; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'plan', label: 'Plan' },
  { key: 'activity', label: 'Activity' },
  { key: 'files', label: 'Files' },
];

export function IssueDetailTabs({
  active,
  onChange,
  overview,
  plan,
  activity,
  files,
}: IssueDetailTabsProps) {
  const [visited, setVisited] = useState<Set<IssueDetailTabKey>>(() => new Set([active]));
  const tabRefs = useRef<Record<IssueDetailTabKey, HTMLButtonElement | null>>({
    overview: null,
    plan: null,
    activity: null,
    files: null,
  });

  useEffect(() => {
    if (!visited.has(active)) {
      setVisited((prev) => {
        const next = new Set(prev);
        next.add(active);
        return next;
      });
    }
  }, [active, visited]);

  const focusTab = useCallback((key: IssueDetailTabKey) => {
    tabRefs.current[key]?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const currentIndex = TAB_ORDER.findIndex((t) => t.key === active);
      if (currentIndex < 0) return;
      let nextIndex = currentIndex;
      switch (event.key) {
        case 'ArrowRight':
          nextIndex = (currentIndex + 1) % TAB_ORDER.length;
          break;
        case 'ArrowLeft':
          nextIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = TAB_ORDER.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      const nextKey = TAB_ORDER[nextIndex].key;
      onChange(nextKey);
      focusTab(nextKey);
    },
    [active, onChange, focusTab],
  );

  const panels: Record<IssueDetailTabKey, ReactNode> = {
    overview,
    plan,
    activity,
    files,
  };

  return (
    <div>
      <div
        role="tablist"
        aria-label="Issue detail sections"
        onKeyDown={handleKeyDown}
        className="flex gap-1 border-b border-outline-variant/20"
      >
        {TAB_ORDER.map(({ key, label }) => {
          const isActive = key === active;
          return (
            <button
              key={key}
              ref={(el) => {
                tabRefs.current[key] = el;
              }}
              type="button"
              role="tab"
              id={`issue-tab-${key}`}
              aria-selected={isActive}
              aria-controls={`issue-tabpanel-${key}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onChange(key)}
              className={
                isActive
                  ? '-mb-px border-b-2 border-primary px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-primary'
                  : 'border-b-2 border-transparent px-3 py-2 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant hover:text-on-surface'
              }
            >
              {label}
            </button>
          );
        })}
      </div>
      {TAB_ORDER.map(({ key }) =>
        visited.has(key) ? (
          <div
            key={key}
            role="tabpanel"
            id={`issue-tabpanel-${key}`}
            aria-labelledby={`issue-tab-${key}`}
            hidden={active !== key}
            className="pt-6"
          >
            {panels[key]}
          </div>
        ) : null,
      )}
    </div>
  );
}
