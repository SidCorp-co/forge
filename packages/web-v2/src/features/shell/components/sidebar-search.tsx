
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
        className="inline-flex size-9 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
      >
        {/* the collapsed rail is icons only: Search is the icon's name on hover, never a word under it (ISS-1073) */}
        <Icon name="search" size={18} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="flex h-9 w-full items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-subtle transition-colors hover:border-link hover:bg-hover max-md:min-h-11"
    >
      <Icon name="search" size={15} />
      <span className="fg-body-sm flex-1 truncate text-left">{t("shell.search.placeholder")}</span>
      <Kbd>⌘K</Kbd>
    </button>
  );
}
