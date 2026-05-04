'use client';

import { useState } from 'react';
import { useDeletePmPolicy, usePmPolicies } from '../hooks/use-pm-policies';
import type { PmPolicy } from '../types';
import { PmPolicyEditor } from './pm-policy-editor';

export function PmPoliciesList({ projectId }: { projectId: string }) {
  const { data: policies, isLoading } = usePmPolicies(projectId);
  const del = useDeletePmPolicy(projectId);
  const [editing, setEditing] = useState<PmPolicy | null>(null);
  const [creating, setCreating] = useState(false);

  function handleDelete(p: PmPolicy) {
    if (
      !window.confirm(
        `Delete policy '${p.name}'? This also drops the embedding.`,
      )
    )
      return;
    del.mutate(p.id);
  }

  return (
    <section className="space-y-3 rounded-lg border border-outline-variant/30 bg-surface-container-low p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-on-surface">Policies</h2>
        {!creating && !editing && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="rounded bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary"
          >
            New policy
          </button>
        )}
      </header>

      {(creating || editing) && (
        <PmPolicyEditor
          projectId={projectId}
          policy={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      {isLoading && <p className="text-sm text-outline">Loading policies…</p>}
      {!isLoading &&
        policies &&
        policies.length === 0 &&
        !creating &&
        !editing && <p className="text-sm text-outline">No policies yet.</p>}

      {policies && policies.length > 0 && (
        <ul className="divide-y divide-outline-variant/30">
          {policies.map((p) => (
            <li
              key={p.id}
              className="flex items-start justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-on-surface">{p.name}</span>
                  <span className="rounded bg-surface-container-high px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-on-surface-variant">
                    p{p.priority}
                  </span>
                  {!p.enabled && (
                    <span className="rounded bg-warning-surface px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warning">
                      disabled
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-on-surface-variant">
                  {p.body}
                </p>
              </div>
              <div className="shrink-0 space-x-2">
                <button
                  type="button"
                  onClick={() => setEditing(p)}
                  className="text-xs text-info hover:underline"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(p)}
                  className="text-xs text-error hover:underline"
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
