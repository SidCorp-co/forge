'use client';

import { useParams } from 'next/navigation';
import { Loader2, RefreshCw } from 'lucide-react';
import { useKnowledgeIndex, useCodebaseIndex } from './hooks';
import { KnowledgeView } from './components';

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function KnowledgePage() {
  const { slug } = useParams<{ slug: string }>();
  const { knowledgeIndex, knowledgeIndexedAt, isLoading, project } = useKnowledgeIndex(slug);
  const { startIndexing, status, error, isIndexing } = useCodebaseIndex(project?.documentId, slug);

  if (isLoading) {
    return <p className="text-sm text-outline">Loading...</p>;
  }

  const hasDevice = !!project?.defaultDevice;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-on-surface">Knowledge</h1>
          {knowledgeIndexedAt && (
            <p className="text-xs text-outline mt-0.5">
              Last indexed: {formatRelativeTime(knowledgeIndexedAt)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status === 'completed' && (
            <span className="text-xs text-success">Indexing completed</span>
          )}
          {status === 'failed' && error && (
            <span className="text-xs text-danger">{error}</span>
          )}
          {hasDevice ? (
            <button
              onClick={startIndexing}
              disabled={isIndexing}
              className="flex items-center gap-1.5 border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
            >
              {isIndexing ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {isIndexing ? 'Indexing...' : 'Index Codebase'}
            </button>
          ) : (
            <span className="text-xs text-outline">
              Connect a desktop device in Settings to enable indexing
            </span>
          )}
        </div>
      </div>
      <KnowledgeView
        knowledgeIndex={knowledgeIndex ?? {}}
        onIndex={hasDevice ? startIndexing : undefined}
        isIndexing={isIndexing}
      />
    </div>
  );
}
