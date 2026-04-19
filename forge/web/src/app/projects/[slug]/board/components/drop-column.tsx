'use client';

import { useState, type DragEvent } from 'react';
import { cn } from '@/lib/utils/cn';

interface DropColumnProps {
  label: string;
  color: string;
  bg: string;
  count: number;
  status: string;
  onDrop: (itemId: string, status: string) => void;
  children: React.ReactNode;
  dragType: 'issueId' | 'taskId';
}

export function DropColumn({ label, color, bg, count, status, onDrop, children, dragType }: DropColumnProps) {
  const [over, setOver] = useState(false);

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

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'min-w-[180px] flex-1 rounded-lg border-t-4 p-2.5 sm:p-3 transition-colors',
        color,
        bg,
        over && 'ring-2 ring-info ring-inset',
      )}
    >
      <h3 className="mb-3 flex items-center justify-between text-sm font-semibold">
        {label}
        <span className="rounded-full bg-surface-container-low px-2 py-0.5 text-xs font-normal text-primary-fixed shadow-sm">
          {count}
        </span>
      </h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}
