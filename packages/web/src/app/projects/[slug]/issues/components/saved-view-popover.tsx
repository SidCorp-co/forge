'use client';

import { useEffect, useRef, useState } from 'react';
import { Bookmark } from 'lucide-react';
import { Button, Input } from '@/components/ui';

interface SavedViewPopoverProps {
  onSave: (name: string) => void;
}

export function SavedViewPopover({ onSave }: SavedViewPopoverProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function submit() {
    if (!name.trim()) return;
    onSave(name);
    setName('');
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-sm border border-outline-variant/30 px-3 py-2 text-sm text-outline transition-colors hover:bg-surface-container-high"
        aria-label="Save current view"
      >
        <Bookmark className="h-3.5 w-3.5" /> Save view
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-sm border border-outline-variant/30 bg-surface-container p-3 shadow-lg">
          <Input
            type="text"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="View name"
            aria-label="View name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') setOpen(false);
            }}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-sm text-outline hover:text-on-surface"
            >
              Cancel
            </button>
            <Button onClick={submit}>Save</Button>
          </div>
        </div>
      )}
    </div>
  );
}
