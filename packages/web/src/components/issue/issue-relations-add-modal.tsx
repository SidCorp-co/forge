'use client';

import { useEffect, useMemo, useState } from 'react';
import { Modal, Button, Input, Select, Textarea, Skeleton } from '@/components/ui';
import { useIssueSearch } from '@/features/issue/hooks/use-issues';
import {
  DEPENDENCY_KINDS,
  type DependencyKind,
} from '@/features/issue/api/issue-api';
import { useAddDependency } from '@/features/issue/hooks/use-issue-dependencies';
import { ApiError } from '@/lib/api/client';

interface Props {
  open: boolean;
  onClose: () => void;
  issueId: string;
  projectId: string;
}

const KIND_LABELS: Record<DependencyKind, string> = {
  blocks: 'Blocks',
  relates: 'Relates to',
  duplicates: 'Duplicates',
  parent: 'Parent of',
  decomposes: 'Decomposes into',
};

export function IssueRelationsAddModal({ open, onClose, issueId, projectId }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [kind, setKind] = useState<DependencyKind>('blocks');
  const [reason, setReason] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(t);
  }, [query, open]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setDebounced('');
      setSelectedId(null);
      setKind('blocks');
      setReason('');
      setErrorMsg(null);
    }
  }, [open]);

  const search = useIssueSearch({
    projectId,
    q: debounced || undefined,
    limit: 20,
  });

  const candidates = useMemo(() => {
    const items = search.data?.items ?? [];
    return items.filter((i) => i.id !== issueId);
  }, [search.data, issueId]);

  const addMutation = useAddDependency(issueId);

  const isSelfEdge = selectedId === issueId;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || isSelfEdge) return;
    setErrorMsg(null);
    try {
      await addMutation.mutateAsync({
        dependsOnId: selectedId,
        kind,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'CYCLE_DETECTED') {
          setErrorMsg('Cycle detected — this edge would create a loop.');
          return;
        }
        if (err.code === 'CROSS_PROJECT') {
          setErrorMsg('Pick an issue in the same project.');
          return;
        }
        if (err.code === 'SELF_DEP') {
          setErrorMsg('Cannot self-link.');
          return;
        }
        setErrorMsg(err.message);
        return;
      }
      setErrorMsg(err instanceof Error ? err.message : 'Add failed');
    }
  }

  return (
    <Modal open={open} onClose={onClose}>
      <div className="px-5 py-4 sm:px-6">
        <h3 className="mb-4 text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Add relation
        </h3>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
              Find issue
            </label>
            <Input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ISS-12 or title…"
              autoFocus
            />
            <div className="mt-2 max-h-48 overflow-y-auto rounded-sm border border-outline-variant/20 bg-surface-container-low">
              {search.isLoading ? (
                <div className="space-y-1 p-2">
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-6 w-full" />
                </div>
              ) : candidates.length === 0 ? (
                <div className="p-3 text-[11px] text-outline">No issues found.</div>
              ) : (
                <ul className="divide-y divide-outline-variant/10">
                  {candidates.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(i.id)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors ${
                          selectedId === i.id
                            ? 'bg-primary/10 text-on-surface'
                            : 'text-on-surface hover:bg-surface-container-high'
                        }`}
                      >
                        <span className="font-mono text-[10px] text-primary">
                          {i.displayId}
                        </span>
                        <span className="truncate">{i.title}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
              Relation type
            </label>
            <Select value={kind} onChange={(e) => setKind(e.currentTarget.value as DependencyKind)}>
              {DEPENDENCY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-outline">
              Reason (optional)
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why add this relation?"
            />
          </div>

          {errorMsg && (
            <p className="text-[10px] uppercase tracking-widest text-error">{errorMsg}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!selectedId || isSelfEdge || addMutation.isPending}
            >
              {addMutation.isPending ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
