'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { cn } from '@/lib/utils/cn';
import type { IssueStatus } from '@/features/issue/types';

interface DropColumnProps {
  label: string;
  color: string;
  bg: string;
  count: number;
  status: string;
  onDrop: (itemId: string, status: string) => void;
  children: React.ReactNode;
  dragType: 'issueId' | 'taskId';
  wipCurrent?: number;
  wipLimit?: number | null;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onEditWipLimit?: (status: IssueStatus, value: number | null) => void;
}

export function DropColumn({
  label,
  color,
  bg,
  count,
  status,
  onDrop,
  children,
  dragType,
  wipCurrent,
  wipLimit,
  collapsed = false,
  onToggleCollapsed,
  onEditWipLimit,
}: DropColumnProps) {
  const [over, setOver] = useState(false);
  const [editingLimit, setEditingLimit] = useState(false);
  const [limitDraft, setLimitDraft] = useState<string>(
    wipLimit != null ? String(wipLimit) : '',
  );
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editingLimit) return;
    function onPointerDown(e: PointerEvent) {
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(e.target as Node)) return;
      setEditingLimit(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [editingLimit]);

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOver(true);
  };

  const handleDragLeave = () => setOver(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const itemId = e.dataTransfer.getData(dragType);
    if (itemId) onDrop(itemId, status);
  };

  const hasWip = wipCurrent != null && wipLimit != null;
  const overWip = hasWip && (wipCurrent as number) > (wipLimit as number);

  const handleSaveLimit = () => {
    if (!onEditWipLimit) return;
    const trimmed = limitDraft.trim();
    if (!trimmed) {
      onEditWipLimit(status as IssueStatus, null);
    } else {
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed) || parsed < 0) return;
      onEditWipLimit(status as IssueStatus, parsed);
    }
    setEditingLimit(false);
  };

  const handleClearLimit = () => {
    if (!onEditWipLimit) return;
    onEditWipLimit(status as IssueStatus, null);
    setLimitDraft('');
    setEditingLimit(false);
  };

  if (collapsed) {
    return (
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'w-14 rounded-lg border-t-4 p-2 transition-colors flex flex-col items-center',
          color,
          bg,
          over && 'bg-info-surface/30 ring-2 ring-info ring-inset',
          overWip && 'ring-2 ring-warning',
        )}
      >
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="mb-2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
          aria-label="Expand column"
        >
          ▸
        </button>
        <div
          className="text-xs font-semibold"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          {label}
        </div>
        <span className="mt-2 rounded-full bg-surface-container-low px-2 py-0.5 text-xs font-normal text-primary-fixed shadow-sm">
          {count}
        </span>
        <div className="h-full" />
      </div>
    );
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'min-w-[180px] flex-1 rounded-lg border-t-4 p-2.5 sm:p-3 transition-colors',
        color,
        bg,
        over && 'bg-info-surface/30 ring-2 ring-info ring-inset',
        overWip && 'ring-2 ring-warning',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          {onToggleCollapsed && (
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
              aria-label="Collapse column"
            >
              ▾
            </button>
          )}
          {label}
        </h3>
        <div className="flex items-center gap-1.5">
          {hasWip ? (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-normal shadow-sm',
                overWip
                  ? 'bg-warning-dim/30 text-warning'
                  : 'bg-surface-container-low text-primary-fixed',
              )}
            >
              {wipCurrent} / {wipLimit}
              {overWip ? ' ⚠' : ''}
            </span>
          ) : (
            <span className="rounded-full bg-surface-container-low px-2 py-0.5 text-xs font-normal text-primary-fixed shadow-sm">
              {count}
            </span>
          )}
          {onEditWipLimit && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setLimitDraft(wipLimit != null ? String(wipLimit) : '');
                  setEditingLimit((v) => !v);
                }}
                className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-xs text-on-surface-variant hover:bg-surface-container hover:text-on-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                aria-label="Edit WIP limit"
              >
                ⋯
              </button>
              {editingLimit && (
                <div
                  ref={popoverRef}
                  className="absolute right-0 top-full z-30 mt-1 flex w-44 flex-col gap-2 rounded-lg border bg-surface-container-low p-2 shadow-lg"
                >
                  <input
                    type="number"
                    min={0}
                    inputMode="numeric"
                    placeholder="Limit"
                    value={limitDraft}
                    onChange={(e) => setLimitDraft(e.currentTarget.value)}
                    className="w-full rounded border bg-surface px-2 py-1 text-sm"
                  />
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={handleClearLimit}
                      className="rounded px-2 py-1 text-xs text-on-surface-variant hover:bg-surface-container"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveLimit}
                      className="rounded bg-primary px-2 py-1 text-xs text-on-primary hover:opacity-90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
