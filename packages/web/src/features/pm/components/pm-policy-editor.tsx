'use client';

import { useState } from 'react';
import { useCreatePmPolicy, useUpdatePmPolicy } from '../hooks/use-pm-policies';
import type { PmPolicy } from '../types';

interface Props {
  projectId: string;
  policy: PmPolicy | null;
  onClose: () => void;
}

export function PmPolicyEditor({ projectId, policy, onClose }: Props) {
  const [name, setName] = useState(policy?.name ?? '');
  const [body, setBody] = useState(policy?.body ?? '');
  const [enabled, setEnabled] = useState(policy?.enabled ?? true);
  const [priority, setPriority] = useState(policy?.priority ?? 0);
  const create = useCreatePmPolicy(projectId);
  const update = useUpdatePmPolicy(projectId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;

    if (policy) {
      update.mutate(
        {
          id: policy.id,
          patch: { name: trimmedName, body: trimmedBody, enabled, priority },
        },
        { onSuccess: () => onClose() },
      );
    } else {
      create.mutate(
        { name: trimmedName, body: trimmedBody, enabled, priority },
        { onSuccess: () => onClose() },
      );
    }
  }

  const pending = create.isPending || update.isPending;
  const error = create.error?.message ?? update.error?.message;

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-lg border border-outline-variant/30 bg-surface-container-low p-4"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr_auto]">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Policy name"
          maxLength={255}
          className="rounded border border-outline-variant bg-surface px-3 py-1.5 text-sm text-on-surface"
        />
        <input
          type="number"
          value={priority}
          min={0}
          max={1000}
          onChange={(e) =>
            setPriority(
              Math.max(0, Math.min(1000, Number(e.target.value) || 0)),
            )
          }
          placeholder="Priority"
          className="rounded border border-outline-variant bg-surface px-3 py-1.5 text-sm text-on-surface"
        />
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enabled
        </label>
      </div>
      <textarea
        rows={10}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Free-text Markdown body. Embedded for retrieval by the PM agent."
        className="w-full rounded border border-outline-variant bg-surface px-3 py-2 font-mono text-xs text-on-surface"
      />
      {error && <p className="text-xs text-error">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-outline-variant px-3 py-1.5 text-sm text-on-surface-variant"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={pending || !name.trim() || !body.trim()}
          className="rounded bg-primary px-4 py-1.5 text-sm font-semibold text-on-primary disabled:opacity-50"
        >
          {pending ? 'Saving…' : policy ? 'Update' : 'Create'}
        </button>
      </div>
    </form>
  );
}
