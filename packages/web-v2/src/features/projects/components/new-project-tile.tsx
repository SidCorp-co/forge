'use client';

// Dashed "New project" tile (Cards view). `onClick` opens the create-project
// dialog (ISS-319) hosted by the projects console.
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
