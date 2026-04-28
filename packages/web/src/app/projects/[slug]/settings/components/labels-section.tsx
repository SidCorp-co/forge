'use client';

import { useState } from 'react';
import { Plus, Tag, Trash2 } from 'lucide-react';
import {
  useLabels,
  useCreateLabel,
  useUpdateLabel,
  useDeleteLabel,
} from '@/features/label/hooks/use-labels';
import type { Label } from '@/features/label/types';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatApiError } from '@/lib/api/error';

const DEFAULT_COLOR = '#3b82f6';

export function LabelsSection({ projectId }: { projectId: string }) {
  const { data, isLoading, error } = useLabels(projectId);
  const createLabel = useCreateLabel(projectId);
  const updateLabel = useUpdateLabel(projectId);
  const deleteLabel = useDeleteLabel(projectId);

  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState(DEFAULT_COLOR);

  const labels = data?.data ?? [];

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = draftName.trim();
    if (!name) return;
    createLabel.mutate(
      { name, color: draftColor, project: projectId },
      {
        onSuccess: () => {
          setDraftName('');
          setDraftColor(DEFAULT_COLOR);
        },
      },
    );
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          <Tag className="h-3.5 w-3.5" />
          Labels
        </h2>
        <p className="mt-1 text-xs text-outline">
          Tag issues with reusable labels. Color-coded for quick scanning.
        </p>
      </div>

      <form
        onSubmit={handleCreate}
        className="flex flex-wrap items-center gap-2 rounded-sm border border-outline-variant/20 bg-surface-container-low p-3"
      >
        <input
          type="color"
          value={draftColor}
          onChange={(e) => setDraftColor(e.target.value)}
          className="h-8 w-10 cursor-pointer rounded-sm border border-outline-variant/30 bg-transparent"
          aria-label="Label color"
        />
        <input
          type="text"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="New label name…"
          className="h-8 flex-1 min-w-[8rem] rounded-sm border border-outline-variant/30 bg-surface-container-high px-2 text-xs text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
        />
        <button
          type="submit"
          disabled={createLabel.isPending || !draftName.trim()}
          className="inline-flex items-center gap-1 rounded-sm border border-outline-variant/30 bg-primary px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-on-primary hover:bg-primary/90 disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          {createLabel.isPending ? 'Adding…' : 'Add'}
        </button>
        {createLabel.error && (
          <p className="basis-full text-[10px] uppercase tracking-widest text-error">
            {formatApiError(createLabel.error)}
          </p>
        )}
      </form>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : error ? (
        <p className="text-[10px] uppercase tracking-widest text-error">
          {formatApiError(error)}
        </p>
      ) : labels.length === 0 ? (
        <EmptyState
          icon={<Tag className="h-8 w-8" />}
          title="No labels yet"
          description="Create your first label using the form above."
        />
      ) : (
        <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
          {labels.map((l) => (
            <LabelRow
              key={l.documentId}
              label={l}
              onSave={(patch) =>
                updateLabel.mutate({ documentId: l.documentId, data: patch })
              }
              onDelete={() => {
                if (confirm(`Delete label "${l.name}"?`)) {
                  deleteLabel.mutate(l.documentId);
                }
              }}
              savingId={updateLabel.isPending ? updateLabel.variables?.documentId : undefined}
              deletingId={deleteLabel.isPending ? deleteLabel.variables : undefined}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

interface LabelRowProps {
  label: Label;
  onSave: (patch: { name?: string; color?: string }) => void;
  onDelete: () => void;
  savingId?: string;
  deletingId?: string;
}

function LabelRow({ label, onSave, onDelete, savingId, deletingId }: LabelRowProps) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color || DEFAULT_COLOR);
  const dirty = name !== label.name || color !== label.color;
  const isSaving = savingId === label.documentId;
  const isDeleting = deletingId === label.documentId;

  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2">
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-7 w-9 cursor-pointer rounded-sm border border-outline-variant/30 bg-transparent"
        aria-label="Label color"
      />
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 flex-1 min-w-[8rem] rounded-sm border border-outline-variant/30 bg-surface-container-high px-2 text-xs text-on-surface focus:border-primary focus:outline-none"
      />
      <button
        type="button"
        disabled={!dirty || isSaving}
        onClick={() => onSave({ name: name.trim(), color })}
        className="rounded-sm border border-outline-variant/30 bg-surface-container-high px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-surface-container-highest disabled:opacity-50"
      >
        {isSaving ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        disabled={isDeleting}
        onClick={onDelete}
        className="rounded p-1 text-outline hover:bg-error-container/20 hover:text-error disabled:opacity-50"
        aria-label="Delete label"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
