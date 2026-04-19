'use client';

import { useState } from 'react';
import type { KnowledgeIndex } from '@/features/project/types';
import { KnowledgeTreeView } from './knowledge-tree-view';
import { KnowledgeGraphView, type GraphLayout } from './knowledge-graph-view';

type ViewMode = 'list' | 'force' | 'radial' | 'mindmap';

const VIEW_OPTIONS: { value: ViewMode; label: string }[] = [
  { value: 'force', label: 'Force' },
  { value: 'radial', label: 'Radial' },
  { value: 'mindmap', label: 'Mind Map' },
  { value: 'list', label: 'List' },
];

interface KnowledgeViewProps {
  knowledgeIndex: Record<string, KnowledgeIndex>;
  onIndex?: () => void;
  isIndexing?: boolean;
}

export function KnowledgeView({ knowledgeIndex, onIndex, isIndexing }: KnowledgeViewProps) {
  const [view, setView] = useState<ViewMode>('force');

  if (!knowledgeIndex || Object.keys(knowledgeIndex).length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-outline">
        <p className="text-sm">No knowledge index available.</p>
        {onIndex ? (
          <button
            onClick={onIndex}
            disabled={isIndexing}
            className="mt-3 rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            {isIndexing ? 'Indexing...' : 'Index Codebase'}
          </button>
        ) : (
          <p className="text-xs mt-1">Connect a desktop device in Settings to enable indexing.</p>
        )}
      </div>
    );
  }

  const graphLayout: GraphLayout | null = view === 'list' ? null : view;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-on-surface-variant">Knowledge Index</h2>
        <div className="flex gap-1 rounded-md border border-outline-variant/30 p-0.5">
          {VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setView(opt.value)}
              className={`rounded px-2.5 py-1 text-xs ${view === opt.value ? 'bg-surface-container text-on-surface' : 'text-primary-fixed hover:text-on-surface-variant'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-4">
        {Object.entries(knowledgeIndex).map(([repoName, index]) => (
          <div key={repoName}>
            <p className="mb-1 text-xs font-medium text-primary-fixed">{repoName}</p>
            {graphLayout && index.domains ? (
              <KnowledgeGraphView index={index} layout={graphLayout} />
            ) : (
              <KnowledgeTreeView index={index} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
