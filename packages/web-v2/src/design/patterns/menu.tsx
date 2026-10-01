"use client";

import { Fragment, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils/cn";
import { Icon, type IconName } from "@/design/icons/icon";

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  checked?: boolean;
  group?: string;
}

export interface MenuProps {
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  side?: "top" | "bottom";
  className?: string;
  triggerClassName?: string;
}

function groupsOf(items: MenuItem[]) {
  const runs: Array<{ group: string | undefined; items: Array<{ it: MenuItem; i: number }> }> = [];
  items.forEach((it, i) => {
    const last = runs[runs.length - 1];
    if (last && last.group === it.group) last.items.push({ it, i });
    else runs.push({ group: it.group, items: [{ it, i }] });
  });
  return runs;
}

const ITEM =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-13-5 transition-colors focus:bg-hover data-highlighted:bg-hover";

function Row({ it }: { it: MenuItem }) {
  const icon = it.icon && (
    <Icon
      name={it.icon}
      size={16}
      style={it.danger ? { color: "var(--red-500)" } : { color: "var(--fg-subtle)" }}
    />
  );
  const tone = it.danger ? "text-[color:var(--red-600)]" : it.disabled ? "text-subtle" : "text-fg";
  if (it.checked !== undefined) {
    return (
      <DropdownMenuCheckboxItem
        checked={it.checked}
        disabled={it.disabled}
        closeOnClick
        onCheckedChange={() => it.onSelect?.()}
        className={cn(ITEM, "pr-8", tone)}
      >
        {icon}
        {it.label}
      </DropdownMenuCheckboxItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={it.disabled}
      onClick={() => it.onSelect?.()}
      className={cn(ITEM, tone, it.disabled && "data-disabled:opacity-100")}
    >
      {icon}
      {it.label}
    </DropdownMenuItem>
  );
}

export function Menu({
  trigger,
  items,
  align = "right",
  side = "bottom",
  className,
  triggerClassName,
}: MenuProps) {
  return (
    <div className={cn("relative inline-flex", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          nativeButton={false}
          tabIndex={-1}
          render={<span className={cn("outline-none", triggerClassName)} />}
        >
          {trigger}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={side}
          align={align === "right" ? "end" : "start"}
          sideOffset={6}
          className="w-auto min-w-[180px] rounded-lg border border-line bg-surface p-1.5 text-fg shadow-lg ring-0"
        >
          {groupsOf(items).map((run) => {
            const first = run.items[0]?.i ?? 0;
            const rows = run.items.map(({ it, i }) => (
              <Fragment key={`${i}-${it.label}`}>
                {it.separatorBefore && <DropdownMenuSeparator className="mx-0 my-1 bg-line" />}
                <Row it={it} />
              </Fragment>
            ));
            if (run.group === undefined) return <Fragment key={`run-${first}`}>{rows}</Fragment>;
            return (
              <DropdownMenuGroup key={`run-${first}`}>
                {first > 0 && <DropdownMenuSeparator className="mx-0 my-1 bg-line" />}
                <DropdownMenuLabel className="fg-overline px-2.5 pb-1 pt-1 text-subtle">{run.group}</DropdownMenuLabel>
                {rows}
              </DropdownMenuGroup>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
