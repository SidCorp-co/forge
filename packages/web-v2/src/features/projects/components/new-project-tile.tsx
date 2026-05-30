'use client';

// Dashed "New project" tile (Cards view). Create is a bounded fast-follow — for
// now it surfaces a stub toast, matching the foundation's New-issue stub.
import { Icon } from '@/design';

export interface NewProjectTileProps {
  onClick: () => void;
}

export function NewProjectTile({ onClick }: NewProjectTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-[156px] flex-col items-center justify-center gap-2.5 rounded-lg border-[1.5px] border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:bg-accent-tint hover:text-accent-text"
    >
      <span className="flex size-[38px] items-center justify-center rounded-md bg-sunken transition-colors group-hover:bg-surface">
        <Icon name="plus" size={22} className="text-subtle group-hover:text-accent" />
      </span>
      <span className="text-sm font-semibold">New project</span>
    </button>
  );
}
