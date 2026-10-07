"use client";

import { Icon, Kbd } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";

export function SidebarSearch({ onOpen, compact = false, icon = false }: { onOpen: () => void; compact?: boolean; icon?: boolean }) {
  const t = useCopy();
  const label = t("shell.search.label");
  if (icon) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={label}
        className="inline-flex size-7 flex-none items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <Icon name="search" size={16} />
      </button>
    );
  }
  if (compact) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={label}
        className="inline-flex w-[76px] flex-col items-center gap-1 rounded-md py-1.5 text-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        <Icon name="search" size={18} />
        <span className="text-10 font-semibold text-muted">{t("shell.search.short")}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-subtle transition-colors hover:border-[color:var(--link)] hover:bg-hover max-md:min-h-[44px]"
    >
      <Icon name="search" size={15} />
      <span className="fg-body-sm flex-1 truncate text-left">{t("shell.search.placeholder")}</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}
