
import { Icon, Tooltip } from "@/design";
import { ForgeVersion } from "@/features/version";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

interface SidebarVersionProps {
  onDocs: () => void;
  activeKey: string;
}

/** The version at the foot of the phone's drawer, with the Docs button after it; the desktop rail has both in its account menu (ISS-1331). */
export function SidebarVersion({ onDocs, activeKey }: SidebarVersionProps) {
  const t = useCopy();
  const docs = t("shell.docs");
  return (
    <div className="flex min-w-0 items-center gap-1">
      <ForgeVersion className="fg-caption truncate" />
      <Tooltip label={docs}>
        <button
          type="button"
          onClick={onDocs}
          aria-label={docs}
          aria-current={activeKey === "docs" ? "page" : undefined}
          className={cn(
            "inline-flex size-7 flex-none items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-fg max-md:size-11",
            activeKey === "docs" ? "text-accent-text" : "text-subtle",
          )}
        >
          <Icon name="book" size={15} />
        </button>
      </Tooltip>
    </div>
  );
}
