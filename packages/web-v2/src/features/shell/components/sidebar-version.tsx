
import { Icon, Tooltip } from "@/design";
import { ForgeVersion, useForgeVersion } from "@/features/version";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";

interface SidebarVersionProps {
  onDocs: () => void;
  activeKey: string;
  /** The 88px rail: the Docs button alone, the version on its hover, never a version cut to "v0.4...." (ISS-1073). */
  compact?: boolean;
}

/** The version at the foot of the sidebar, with the Docs button after it. */
export function SidebarVersion({ onDocs, activeKey, compact = false }: SidebarVersionProps) {
  const t = useCopy();
  const version = useForgeVersion().data?.version?.trim();
  const docs = compact && version ? `${t("shell.docs")} · Forge v${version}` : t("shell.docs");
  return (
    <div className={cn("flex min-w-0 items-center", compact ? "justify-center" : "gap-1")}>
      {compact ? null : <ForgeVersion className="fg-caption truncate" />}
      <Tooltip label={docs}>
        <button
          type="button"
          onClick={onDocs}
          aria-label={docs}
          aria-current={activeKey === "docs" ? "page" : undefined}
          className={cn(
            "inline-flex flex-none items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-fg max-md:size-11",
            compact ? "size-9" : "size-7",
            activeKey === "docs" ? "text-accent-text" : "text-subtle",
          )}
        >
          <Icon name="book" size={compact ? 17 : 15} />
        </button>
      </Tooltip>
    </div>
  );
}
