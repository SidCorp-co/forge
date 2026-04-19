'use client';

import { useState, useMemo, useEffect } from 'react';
import Link from 'next/link';
import { X, Plus, Loader2 } from 'lucide-react';
import { useIssues } from '@/features/issue/hooks/use-issues';
import { formatStatusLabel } from '@/lib/utils/format-status';
import { CLOSED_STATUSES } from '@/lib/constants';

const RELATION_TYPES = [
  { value: 'blocked_by', label: 'Blocked by' },
  { value: 'blocks', label: 'Blocks' },
  { value: 'depends_on', label: 'Depends on' },
  { value: 'depended_on_by', label: 'Depended on by' },
  { value: 'related_to', label: 'Related to' },
  { value: 'duplicate_of', label: 'Duplicate of' },
  { value: 'caused_by', label: 'Caused by' },
  { value: 'fixed_by', label: 'Fixed by' },
] as const;

type RelationType = (typeof RELATION_TYPES)[number]['value'];

interface Relation {
  type: string;
  targetDocumentId: string;
  reason?: string;
  targetId?: number;
  targetTitle?: string;
  targetStatus?: string;
}

interface IssueRelationsProps {
  relations: Relation[];
  issueDocumentId: string;
  projectSlug: string;
  onUpdate: (relations: Relation[]) => void;
}

/** GitHub-style status dot: green=open, purple=closed, colored for in-progress states */
function StatusDot({ status }: { status?: string }) {
  const s = status ?? 'open';
  const isClosed = CLOSED_STATUSES.includes(s as any);
  let color = 'bg-success'; // open
  if (isClosed) color = 'bg-surface-variant0';
  else if (['in_progress', 'developed', 'deploying'].includes(s)) color = 'bg-warning-dim/100';
  else if (['testing', 'staging'].includes(s)) color = 'bg-info';
  else if (s === 'reopen') color = 'bg-danger';
  else if (['confirmed', 'approved', 'waiting'].includes(s)) color = 'bg-info-surface/200';

  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} title={formatStatusLabel(s)} />;
}

function getRelationLabel(type: string) {
  return RELATION_TYPES.find((r) => r.value === type)?.label ?? formatStatusLabel(type);
}

function useDebouncedValue(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function IssueRelations({ relations: rawRelations, issueDocumentId, projectSlug, onUpdate }: IssueRelationsProps) {
  const relations = rawRelations.filter((r) => r.targetDocumentId);
  const [adding, setAdding] = useState(false);
  const [relType, setRelType] = useState<RelationType>('related_to');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);

  const { data: searchData, isFetching } = useIssues(
    adding
      ? { projectSlug, search: debouncedSearch || undefined, pageSize: 15, page: 1 }
      : { projectSlug: undefined },
  );
  const searchResults = searchData?.data ?? [];

  const candidates = useMemo(() => {
    const existingIds = new Set([issueDocumentId, ...relations.map((r) => r.targetDocumentId)]);
    return searchResults.filter((i) => !existingIds.has(i.documentId));
  }, [searchResults, relations, issueDocumentId]);

  // Group relations by type
  const grouped = useMemo(() => {
    const map = new Map<string, { relations: Relation[]; indices: number[] }>();
    relations.forEach((r, i) => {
      const group = map.get(r.type) ?? { relations: [], indices: [] };
      group.relations.push(r);
      group.indices.push(i);
      map.set(r.type, group);
    });
    return map;
  }, [relations]);

  function handleAdd(targetDocumentId: string) {
    onUpdate([...relations, { type: relType, targetDocumentId }]);
    setAdding(false);
    setSearch('');
  }

  function handleRemove(index: number) {
    onUpdate(relations.filter((_, i) => i !== index));
  }

  return (
    <div>
      {grouped.size > 0 && (
        <div className="overflow-hidden rounded-md border border-outline-variant/30">
          {[...grouped.entries()].map(([type, group], gi) => (
            <div key={type}>
              {/* Group header */}
              <div className={`flex items-center gap-1.5 bg-surface-container-low px-3 py-1.5 text-xs font-medium text-primary-fixed ${gi > 0 ? 'border-t border-outline-variant/30' : ''}`}>
                {getRelationLabel(type)}
                <span className="text-outline">({group.relations.length})</span>
              </div>
              {/* Items */}
              {group.relations.map((r, ri) => (
                <div
                  key={group.indices[ri]}
                  className="group flex items-center gap-2 border-t border-outline-variant/20 px-3 py-1.5 text-sm hover:bg-surface-container-low"
                >
                  <StatusDot status={r.targetStatus} />
                  <Link
                    href={`/projects/${projectSlug}/issues/${r.targetDocumentId}`}
                    className="flex min-w-0 items-baseline gap-1.5 hover:text-info"
                  >
                    {r.targetId ? (
                      <>
                        <span className="shrink-0 font-medium text-on-surface">ISS-{r.targetId}</span>
                        <span className="min-w-0 truncate text-on-surface-variant">{r.targetTitle}</span>
                      </>
                    ) : (
                      <span className="font-mono text-outline">{r.targetDocumentId.slice(0, 8)}</span>
                    )}
                  </Link>
                  <button
                    onClick={(e) => { e.preventDefault(); handleRemove(group.indices[ri]); }}
                    className="ml-auto shrink-0 rounded p-0.5 text-outline opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                    title="Remove"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className={`${grouped.size > 0 ? 'mt-2' : ''} space-y-2 rounded-md border border-outline-variant/30 bg-surface-container-low p-3`}>
          {/* Relation type tabs */}
          <div className="flex flex-wrap gap-1">
            {RELATION_TYPES.map((rt) => (
              <button
                key={rt.value}
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors ${
                  relType === rt.value
                    ? 'bg-surface text-primary'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-variant'
                }`}
                onClick={() => setRelType(rt.value)}
              >
                {rt.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            className="w-full rounded-md border border-outline-variant/30 px-3 py-1.5 text-sm placeholder:text-outline focus:border-info focus:outline-none focus:ring-1 focus:ring-info"
            placeholder="Search issues by title or ISS-number..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          <div className="max-h-40 overflow-y-auto">
            {isFetching && (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-outline" />
              </div>
            )}
            {!isFetching && candidates.slice(0, 10).map((issue) => (
              <button
                key={issue.documentId}
                className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-info-surface/20"
                onClick={() => handleAdd(issue.documentId)}
              >
                <StatusDot status={issue.status} />
                <span className="shrink-0 font-medium text-on-surface">ISS-{issue.id}</span>
                <span className="min-w-0 truncate text-on-surface-variant">{issue.title}</span>
              </button>
            ))}
            {!isFetching && candidates.length === 0 && (
              <p className="py-2 text-center text-xs text-outline">No matching issues</p>
            )}
          </div>
          <div className="flex justify-end">
            <button
              className="rounded-md px-3 py-1 text-xs text-primary-fixed hover:bg-surface-container-high hover:text-on-surface-variant"
              onClick={() => { setAdding(false); setSearch(''); }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className={`${grouped.size > 0 ? 'mt-2' : ''} inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-primary-fixed hover:bg-surface-container-high hover:text-on-surface-variant`}
        >
          <Plus className="h-3 w-3" />
          Link issue
        </button>
      )}
    </div>
  );
}
