
import { type ReactNode, useMemo, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup as CommandSection,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Icon, type IconName } from "@/design/icons/icon";
import { Kbd } from "@/design/primitives/kbd";
import { cn } from "@/lib/utils/cn";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export type CommandGroup = "page" | "recent" | "pinned" | "navigate" | "actions" | "search";

// a screen's own acts (usePageCommands) lead: they are what the person opened the palette from this page for
const GROUP_ORDER: CommandGroup[] = ["page", "recent", "pinned", "navigate", "actions", "search"];
const GROUP_LABEL: Record<CommandGroup, ProductCopyKey> = {
  page: "shell.palette.page",
  recent: "shell.palette.recent",
  pinned: "shell.palette.pinned",
  navigate: "shell.palette.navigate",
  actions: "shell.palette.actions",
  search: "shell.palette.results",
};

const GROUP_CLASS =
  "p-0 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:pt-1.5 **:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-11 **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.10em] **:[[cmdk-group-heading]]:text-subtle";
const ITEM_CLASS = "group gap-3 rounded-md px-3 py-2 text-sm text-fg data-selected:bg-accent-tint data-selected:text-accent-text";

/** A group of a palette `search`'s results, headed like the commands' groups. */
export function PaletteGroup({ heading, children, testId }: { heading: string; children: ReactNode; testId?: string }) {
  return (
    <CommandSection heading={heading} className={GROUP_CLASS} data-testid={testId}>
      {children}
    </CommandSection>
  );
}

/**
 * One result of a palette `search`. It carries the typed words as its keyword, so the commands'
 * filter keeps it whatever it is titled: the search door, not the palette, decided it matched.
 */
export function PaletteItem({ value, query, onSelect, children, testId }: { value: string; query: string; onSelect: () => void; children: ReactNode; testId?: string }) {
  return (
    <CommandItem value={value} keywords={[query]} onSelect={onSelect} className={cn(ITEM_CLASS, "items-start")} data-testid={testId}>
      {children}
    </CommandItem>
  );
}

export interface Command {
  label: string;
  icon: IconName;
  kbd?: string;
  group?: CommandGroup;
  keywords?: string;
  onRun?: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
  /** What the palette opens searching; the caller keys the palette to open it again with another. */
  initialQuery?: string;
  /**
   * The one search door's results for what is typed (ISS-1256), drawn above the commands. Its items
   * carry the typed words as a keyword, so the commands' filter keeps them, and they lead.
   */
  search?: (query: string, close: () => void) => ReactNode;
}

function matches(_value: string, search: string, keywords?: string[]): number {
  const q = search.toLowerCase().trim();
  if (!q) return 1;
  return keywords?.some((k) => k.toLowerCase().includes(q)) ? 1 : 0;
}

export function CommandPalette({ open, onClose, commands, initialQuery = "", search }: CommandPaletteProps) {
  const [query, setQuery] = useState(initialQuery);
  const searching = Boolean(search) && query.trim().length > 0;
  const t = useCopy();

  const sections = useMemo(() => {
    const byGroup = new Map<CommandGroup, Array<{ cmd: Command; idx: number }>>();
    commands.forEach((cmd, idx) => {
      const g = cmd.group ?? "navigate";
      const items = byGroup.get(g);
      if (items) items.push({ cmd, idx });
      else byGroup.set(g, [{ cmd, idx }]);
    });
    return GROUP_ORDER.flatMap((g) => {
      const items = byGroup.get(g);
      return items ? [{ group: g, items }] : [];
    });
  }, [commands]);

  const run = (cmd: Command) => {
    cmd.onRun?.();
    onClose();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          onClose();
        }
      }}
      title={t("shell.palette.title")}
      description={t("shell.palette.description")}
      className="top-palette-top w-full max-w-xl border border-line bg-surface shadow-overlay sm:max-w-xl"
    >
      <CommandPrimitive filter={matches} loop={false} className="flex size-full flex-col overflow-hidden bg-surface text-fg">
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-3">
          <Icon name="search" size={18} className="text-subtle" />
          <CommandPrimitive.Input
            value={query}
            onValueChange={setQuery}
            placeholder={t("shell.palette.placeholder")}
            className="w-full flex-1 border-0 bg-transparent p-0 text-base text-fg outline-none placeholder:text-disabled focus-visible:shadow-none md:text-15"
          />
          <Kbd>{t("common.key.esc")}</Kbd>
        </div>
        <CommandList label={t("shell.palette.list")} className={searching ? "max-h-[min(520px,65vh)] p-1.5" : "max-h-[360px] p-1.5"}>
          {searching ? null : <CommandEmpty className="fg-body-sm px-3 py-6 text-center">{t("shell.palette.empty")}</CommandEmpty>}
          {searching && search ? search(query, onClose) : null}
          {sections.map((section, si) => (
            <div key={section.group}>
              {si > 0 || searching ? <CommandSeparator className="mx-0 my-1 bg-line-subtle" /> : null}
              <CommandSection
                heading={t(GROUP_LABEL[section.group])}
                className={GROUP_CLASS}
              >
                {section.items.map(({ cmd, idx }) => (
                  <CommandItem
                    key={`${cmd.label}-${idx}`}
                    value={`${section.group}:${idx}:${cmd.label}`}
                    keywords={[cmd.label, cmd.keywords ?? ""]}
                    onSelect={() => run(cmd)}
                    className={ITEM_CLASS}
                  >
                    <Icon name={cmd.icon} size={17} className="text-subtle group-data-[selected=true]:text-accent" />
                    <span className="flex-1 truncate">{cmd.label}</span>
                    {cmd.kbd && <Kbd>{cmd.kbd}</Kbd>}
                  </CommandItem>
                ))}
              </CommandSection>
            </div>
          ))}
        </CommandList>
      </CommandPrimitive>
    </CommandDialog>
  );
}
