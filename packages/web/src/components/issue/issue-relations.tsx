'use client';

import { useState } from 'react';
import Link from 'next/link';
import { X, Plus } from 'lucide-react';
import { Button, Skeleton } from '@/components/ui';
import { useIssueRelations } from '@/features/issue/hooks/use-issue-relations';
import { useDeleteDependency } from '@/features/issue/hooks/use-issue-dependencies';
import { useIssue } from '@/features/issue/hooks/use-issues';
import { useToast } from '@/hooks/use-toast';
import { ToastContainer } from '@/components/ui/toast-container';
import { ApiError } from '@/lib/api/client';
import { formatApiError } from '@/lib/api/error';
import { IssueRelationsAddModal } from './issue-relations-add-modal';
import type { DependencyEdge, DependencyKind } from '@/features/issue/api/issue-api';

interface IssueRelationsProps {
  issueId: string;
  projectId: string;
  projectSlug: string;
}

const KIND_TITLES: Record<DependencyKind, string> = {
  blocks: 'Blocks',
  relates: 'Relates',
  duplicates: 'Duplicates',
  parent: 'Parent / child',
  decomposes: 'Decomposition',
};

const KIND_DIRECTION_LABELS: Record<DependencyKind, { outgoing: string; incoming: string }> = {
  blocks: { outgoing: 'Blocks', incoming: 'Blocked by' },
  relates: { outgoing: 'Relates to', incoming: 'Related from' },
  duplicates: { outgoing: 'Duplicates', incoming: 'Duplicated by' },
  parent: { outgoing: 'Parent of', incoming: 'Child of' },
  // `decomposes` edges are also rendered by `<DecompositionPanel/>` with
  // richer affordances (status dots). The relations panel still lists them
  // for completeness so users can remove a child link from one place.
  decomposes: { outgoing: 'Decomposes into', incoming: 'Part of epic' },
};

export function IssueRelations({ issueId, projectId, projectSlug }: IssueRelationsProps) {
  const relations = useIssueRelations(issueId);
  const [addOpen, setAddOpen] = useState(false);
  const { toasts, addToast } = useToast();
  const deleteDep = useDeleteDependency(issueId);

  async function handleDelete(edgeId: string) {
    try {
      await deleteDep.mutateAsync(edgeId);
      addToast('Removed');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Remove failed';
      addToast(msg);
    }
  }

  return (
    <section id="issue-relations" className="rounded-sm border border-outline-variant/20 bg-surface">
      <div className="flex items-center justify-between border-b border-outline-variant/20 bg-surface-container-low px-4 py-2">
        <h3 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
          Relations
        </h3>
        <Button size="xs" variant="ghost" onClick={() => setAddOpen(true)} aria-label="Add relation">
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      <div className="p-4 text-sm">
        {relations.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        ) : relations.error ? (
          <p className="text-[10px] uppercase tracking-widest text-error">
            {formatApiError(relations.error)}
          </p>
        ) : relations.total === 0 ? (
          <p className="text-[11px] text-outline">No relations yet.</p>
        ) : (
          <ul className="space-y-3">
            {(['blocks', 'relates', 'duplicates', 'parent', 'decomposes'] as DependencyKind[]).map((kind) => {
              const group = relations.groups[kind];
              if (group.outgoing.length === 0 && group.incoming.length === 0) return null;
              return (
                <li key={kind}>
                  <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-outline">
                    {KIND_TITLES[kind]}
                  </h4>
                  <ul className="space-y-1">
                    {group.outgoing.map((edge) => (
                      <RelationRow
                        key={edge.id}
                        edge={edge}
                        currentIssueId={issueId}
                        projectSlug={projectSlug}
                        directionLabel={KIND_DIRECTION_LABELS[kind].outgoing}
                        onDelete={() => handleDelete(edge.id)}
                        deleting={deleteDep.isPending}
                      />
                    ))}
                    {group.incoming.map((edge) => (
                      <RelationRow
                        key={edge.id}
                        edge={edge}
                        currentIssueId={issueId}
                        projectSlug={projectSlug}
                        directionLabel={KIND_DIRECTION_LABELS[kind].incoming}
                        onDelete={() => handleDelete(edge.id)}
                        deleting={deleteDep.isPending}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <IssueRelationsAddModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        issueId={issueId}
        projectId={projectId}
      />
      <ToastContainer toasts={toasts} />
    </section>
  );
}

interface RelationRowProps {
  edge: DependencyEdge;
  currentIssueId: string;
  projectSlug: string;
  directionLabel: string;
  onDelete: () => void;
  deleting: boolean;
}

function RelationRow({
  edge,
  currentIssueId,
  projectSlug,
  directionLabel,
  onDelete,
  deleting,
}: RelationRowProps) {
  const otherId = edge.fromIssueId === currentIssueId ? edge.toIssueId : edge.fromIssueId;
  const target = useIssue(otherId);
  const issue = target.data;

  return (
    <li className="flex items-start justify-between gap-2 rounded-sm border border-outline-variant/20 bg-surface-container-low px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="rounded-sm bg-surface-container-high px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-on-surface-variant">
            {directionLabel}
          </span>
          {issue ? (
            <Link
              href={`/projects/${projectSlug}/issues/${issue.displayId}`}
              className="flex min-w-0 items-center gap-2 text-xs"
            >
              <span className="font-mono text-[10px] text-primary">{issue.displayId}</span>
              <span className="truncate text-on-surface hover:underline">{issue.title}</span>
            </Link>
          ) : target.isLoading ? (
            <Skeleton className="h-4 w-32" />
          ) : (
            <span className="font-mono text-[10px] text-outline">{otherId.slice(0, 8)}…</span>
          )}
        </div>
        {edge.reason && (
          <p className="mt-1 truncate text-[11px] text-on-surface-variant" title={edge.reason}>
            {edge.reason}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={deleting}
        onClick={onDelete}
        className="shrink-0 rounded-sm p-1 text-outline transition-colors hover:bg-error-container/40 hover:text-error disabled:opacity-50"
        aria-label="Remove relation"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
