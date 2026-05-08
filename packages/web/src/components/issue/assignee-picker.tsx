'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Input } from '@/components/ui/input';
import type { ProjectMemberRow } from '@/features/project/hooks/use-project-members';
import { cn } from '@/lib/utils/cn';

interface AssigneePickerProps {
  value: string | null;
  members: ProjectMemberRow[];
  onChange: (userId: string | null) => void;
  compact?: boolean;
  disabled?: boolean;
}

export function AssigneePicker({
  value,
  members,
  onChange,
  compact = false,
  disabled = false,
}: AssigneePickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  const current = useMemo(
    () => members.find((m) => m.userId === value) ?? null,
    [members, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) => m.email.toLowerCase().includes(q));
  }, [members, query]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current) return;
      if (rootRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function handleSelect(next: string | null) {
    onChange(next);
    setOpen(false);
    setQuery('');
  }

  const triggerLabel = current ? current.email : 'Unassigned';

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Assignee: ${triggerLabel}`}
        title={triggerLabel}
        className={cn(
          'inline-flex items-center gap-2 rounded-sm transition-colors disabled:opacity-50',
          compact
            ? 'p-0.5 hover:bg-surface-container-high'
            : 'border border-outline-variant/30 bg-surface-container-low px-2 py-1 text-[11px] text-on-surface hover:bg-surface-container-high',
        )}
      >
        <Avatar
          email={current?.email ?? null}
          userId={current?.userId ?? null}
          size={compact ? 'xs' : 'sm'}
        />
        {!compact && (
          <span className="max-w-[160px] truncate">
            {current ? current.email : 'Unassigned'}
          </span>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-30 mt-1 w-64 overflow-hidden rounded-sm border border-outline-variant/30 bg-surface shadow-lg"
        >
          <div className="border-b border-outline-variant/20 p-2">
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search members…"
              aria-label="Search members"
              autoFocus
              className="text-xs"
            />
          </div>

          <ul className="max-h-64 overflow-y-auto py-1 text-xs">
            <li>
              <button
                type="button"
                onClick={() => handleSelect(null)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-high"
              >
                <Avatar email={null} size="sm" />
                <span className="flex-1 text-on-surface-variant">Unassigned</span>
                {value == null && <Check className="h-3 w-3 text-primary" />}
              </button>
            </li>

            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-outline">No members match</li>
            ) : (
              filtered.map((m) => (
                <li key={m.userId}>
                  <button
                    type="button"
                    onClick={() => handleSelect(m.userId)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-high"
                  >
                    <Avatar email={m.email} userId={m.userId} size="sm" />
                    <span className="flex-1 truncate text-on-surface">{m.email}</span>
                    {value === m.userId && <Check className="h-3 w-3 text-primary" />}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
