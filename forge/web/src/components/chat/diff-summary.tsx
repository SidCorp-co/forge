'use client';

import { useState } from 'react';
import type { BranchDiff, FileDiff } from '@/features/agent/api';

const STATUS_COLORS: Record<string, string> = {
  added: 'text-success',
  modified: 'text-warning',
  deleted: 'text-danger',
  renamed: 'text-info',
};

const STATUS_LABELS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
};

function ChangeBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const maxBlocks = 5;
  const addBlocks = Math.round((additions / total) * maxBlocks);
  const delBlocks = maxBlocks - addBlocks;
  return (
    <span className="ml-2 inline-flex gap-px">
      {Array.from({ length: addBlocks }).map((_, i) => (
        <span key={`a${i}`} className="inline-block h-2.5 w-1.5 rounded-sm bg-success" />
      ))}
      {Array.from({ length: delBlocks }).map((_, i) => (
        <span key={`d${i}`} className="inline-block h-2.5 w-1.5 rounded-sm bg-danger" />
      ))}
    </span>
  );
}

const LINE_STYLES: Record<string, { bg: string; color: string; prefix: string }> = {
  add:     { bg: 'rgba(39, 174, 96, 0.15)', color: '#4ade80', prefix: '+' },
  remove:  { bg: 'rgba(192, 57, 43, 0.15)', color: '#f87171', prefix: '-' },
  context: { bg: 'transparent',              color: '#666666', prefix: ' ' },
};

function DiffLineView({ line }: { line: { kind: string; content: string } }) {
  const { bg, color, prefix } = LINE_STYLES[line.kind] ?? LINE_STYLES.context;
  return (
    <div style={{ backgroundColor: bg }} className="px-3">
      <span className="inline-block w-4 select-none text-right pr-2" style={{ color }}>{prefix}</span>
      <span style={{ color }}>{line.content || ' '}</span>
    </div>
  );
}

function FileDiffView({ file }: { file: FileDiff }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-outline-variant/30 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-container"
      >
        <span className="shrink-0 text-[10px] font-mono text-outline">
          {expanded ? '▼' : '▶'}
        </span>
        <span className={`shrink-0 w-4 text-center text-xs font-bold ${STATUS_COLORS[file.status] || 'text-outline'}`}>
          {STATUS_LABELS[file.status] || '?'}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-on-surface">
          {file.path}
        </span>
        <span className="shrink-0 text-xs font-mono">
          {file.additions > 0 && <span className="text-success">+{file.additions}</span>}
          {file.additions > 0 && file.deletions > 0 && <span className="text-outline"> </span>}
          {file.deletions > 0 && <span className="text-danger">-{file.deletions}</span>}
        </span>
        <ChangeBar additions={file.additions} deletions={file.deletions} />
      </button>

      {expanded && file.hunks.length > 0 && (
        <div className="max-h-96 overflow-auto bg-surface-container-lowest">
          <pre className="font-mono text-[11px] leading-[1.6]">
            {file.hunks.map((hunk, hi) => (
              <div key={hi}>
                <div className="bg-info-surface-low px-3 py-0.5 text-info select-none">
                  {hunk.header}
                </div>
                {hunk.lines.map((line, li) => (
                  <DiffLineView key={li} line={line} />
                ))}
              </div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

export function DiffSummary({ diff }: { diff: BranchDiff | null | undefined }) {
  if (!diff || diff.files.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="text-sm text-outline">No changes recorded</div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Summary bar */}
      <div className="flex items-center gap-4 border-b border-outline-variant/30 px-4 py-2.5 bg-surface-container-low">
        <span className="font-mono text-xs text-on-surface-variant">
          {diff.files.length} file{diff.files.length !== 1 ? 's' : ''} changed
        </span>
        <span className="font-mono text-xs text-success">+{diff.total_additions}</span>
        <span className="font-mono text-xs text-danger">-{diff.total_deletions}</span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-outline">
          {diff.base}...{diff.branch}
        </span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {diff.files.map((file) => (
          <FileDiffView key={file.path} file={file} />
        ))}
      </div>
    </div>
  );
}
