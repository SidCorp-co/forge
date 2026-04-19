'use client';

import { useState } from 'react';
import { Pencil, Check } from 'lucide-react';
import { Markdown } from '@/components/ui/markdown';

interface EditableFieldProps {
  value: string | undefined | null;
  placeholder: string;
  title: string;
  rows?: number;
  onSave: (value: string) => void;
}

export function EditableField({ value, placeholder, title, rows = 4, onSave }: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (editing) {
    return (
      <div className="space-y-4">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
          }}
          rows={rows}
          className="w-full rounded-sm border border-outline-variant/50 bg-surface-container-low px-4 py-3 text-sm text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all shadow-sm"
        />
        <div className="flex gap-2">
          <button
            onClick={() => { onSave(draft); setEditing(false); }}
            className="flex items-center gap-2 rounded-sm bg-primary px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-on-surface-variant shadow-sm transition-all"
          >
            <Check className="h-3 w-3" />
            COMMIT
          </button>
          <button
            onClick={() => setEditing(false)}
            className="rounded-sm border border-outline-variant/30 bg-surface px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-outline hover:bg-surface-container-low hover:text-on-surface transition-all"
          >
            CANCEL
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative min-w-0 w-full overflow-hidden rounded-sm border border-transparent hover:border-outline-variant/30 hover:bg-surface-container-low transition-colors p-3 -mx-3">
      {value ? (
        <Markdown className="text-sm text-tertiary prose prose-invert prose-p:leading-relaxed max-w-none">{value}</Markdown>
      ) : (
        <p className="text-[10px] font-mono tracking-widest text-outline-variant italic uppercase">{placeholder}</p>
      )}
      <button
        onClick={() => { setDraft(value || ''); setEditing(true); }}
        className="absolute right-1.5 top-1.5 rounded-sm p-1.5 text-outline-variant opacity-0 hover:bg-surface-container-high hover:text-on-surface group-hover:opacity-100 transition-all border border-transparent hover:border-outline-variant/30"
        title={title}
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  );
}
