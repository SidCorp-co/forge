"use client";

import { Icon, Kbd } from "@/design";

export function SidebarSearch({ onOpen, compact = false }: { onOpen: () => void; compact?: boolean }) {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label="Search (⌘K)"
        title="Search (⌘K)"
        className="inline-flex w-[76px] flex-col items-center gap-1 rounded-md py-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <Icon name="search" size={18} />
        <span className="text-10 font-semibold text-muted">Search</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Search (⌘K)"
      className="flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-subtle transition-colors hover:border-[color:var(--link)] hover:bg-hover max-md:min-h-[44px]"
    >
      <Icon name="search" size={15} />
      <span className="fg-body-sm flex-1 truncate text-left">Search…</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}
