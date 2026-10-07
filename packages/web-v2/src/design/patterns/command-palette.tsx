"use client";

import { useMemo, useState } from "react";
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
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";

export type CommandGroup = "recent" | "pinned" | "navigate" | "actions" | "search";

const GROUP_ORDER: CommandGroup[] = ["recent", "pinned", "navigate", "actions", "search"];
const GROUP_LABEL: Record<CommandGroup, ProductCopyKey> = {
  recent: "shell.palette.recent",
  pinned: "shell.palette.pinned",
  navigate: "shell.palette.navigate",
  actions: "shell.palette.actions",
  search: "shell.palette.results",
};

export interface Command {
  label: string;
  icon: IconName;
  kbd?: string;
  group?: CommandGroup;
  keywords?: string;
  onRun?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

function matches(_value: string, search: string, keywords?: string[]): number {
  const q = search.toLowerCase().trim();
  if (!q) return 1;
  return keywords?.some((k) => k.toLowerCase().includes(q)) ? 1 : 0;
}

export function CommandPalette({ open, onClose, commands }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
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
      className="top-palette-top w-full max-w-xl border border-line bg-surface shadow-lg sm:max-w-xl"
    >
      <CommandPrimitive filter={matches} loop={false} className="flex size-full flex-col overflow-hidden bg-surface text-fg">
        <div className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-3">
          <Icon name="search" size={18} className="text-subtle" />
          <CommandPrimitive.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t("shell.palette.placeholder")}
            className="w-full flex-1 border-0 bg-transparent p-0 text-base text-fg outline-none placeholder:text-disabled focus-visible:shadow-none md:text-15"
          />
          <Kbd>esc</Kbd>
        </div>
        <CommandList label={t("shell.palette.list")} className="max-h-[360px] p-1.5">
          <CommandEmpty className="fg-body-sm px-3 py-6 text-center">{t("shell.palette.empty")}</CommandEmpty>
          {sections.map((section, si) => (
            <div key={section.group}>
              {si > 0 && <CommandSeparator className="mx-0 my-1 bg-line-subtle" />}
              <CommandSection
                heading={t(GROUP_LABEL[section.group])}
                className="p-0 **:[[cmdk-group-heading]]:px-3 **:[[cmdk-group-heading]]:pb-1 **:[[cmdk-group-heading]]:pt-1.5 **:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-11 **:[[cmdk-group-heading]]:font-semibold **:[[cmdk-group-heading]]:uppercase **:[[cmdk-group-heading]]:tracking-[0.10em] **:[[cmdk-group-heading]]:text-subtle"
              >
                {section.items.map(({ cmd, idx }) => (
                  <CommandItem
                    key={`${cmd.label}-${idx}`}
                    value={`${section.group}:${idx}:${cmd.label}`}
                    keywords={[cmd.label, cmd.keywords ?? ""]}
                    onSelect={() => run(cmd)}
                    className="group gap-3 rounded-md px-3 py-2 text-sm text-fg data-selected:bg-accent-tint data-selected:text-accent-text"
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
