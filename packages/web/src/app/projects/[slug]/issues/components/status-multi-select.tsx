'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { ALL_STATUSES, STATUS_COLORS } from '@/lib/constants';
import type { IssueStatus } from '@/features/issue/types';

interface StatusMultiSelectProps {
  selected: IssueStatus[];
  onChange: (statuses: IssueStatus[]) => void;
  className?: string;
}

export function StatusMultiSelect({ selected, onChange, className }: StatusMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function toggle(value: IssueStatus) {
    const next = selected.includes(value)
      ? selected.filter((s) => s !== value)
      : [...selected, value];
    onChange(next);
  }

  const label = selected.length === 0
    ? 'All statuses'
    : selected.length === 1
      ? ALL_STATUSES.find((s) => s.value === selected[0])?.label ?? selected[0]
      : `${selected.length} statuses`;

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex items-center gap-1.5 rounded-sm border px-3 py-2 text-sm transition-colors min-w-[140px] justify-between',
          selected.length > 0
            ? 'border-on-surface/30 bg-on-surface/5 text-on-surface'
            : 'border-outline-variant/30 text-outline',
        )}
        aria-label="Filter by status"
      >
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-1">
          {selected.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onChange([]); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onChange([]); } }}
              className="rounded-full p-0.5 hover:bg-on-surface/10"
              aria-label="Clear status filter"
            >
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
        </div>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-sm border border-outline-variant/20 bg-surface-container-low shadow-lg">
          {ALL_STATUSES.map((s) => {
            const checked = selected.includes(s.value);
            return (
              <label
                key={s.value}
                className="flex cursor-pointer items-center gap-2 px-3 py-1.5 hover:bg-on-surface/5 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(s.value)}
                  className="h-3.5 w-3.5 rounded border-outline-variant accent-primary"
                />
                <span className={cn('rounded-sm px-1.5 py-0.5 text-xs', STATUS_COLORS[s.value])}>
                  {s.label}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
