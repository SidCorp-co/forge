"use client";

import { cn } from "@/lib/utils/cn";
import { assetPath } from "@/lib/asset";
import { Icon, type IconName } from "@/design/icons/icon";
import { Kicker } from "@/design/primitives/kicker";
import { Tooltip } from "@/design/primitives/tooltip";
import { Menu, type MenuItem } from "./menu";

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  /** A count pill; falsy or 0 hides it. */
  badge?: number;
  /** What the count means, for its tooltip: "Requirements · waiting on you 3: accept r2 (2), …". */
  badgeHint?: string;
  /** A short code shown in a tinted square in place of the icon (an ecosystem's document code). */
  mark?: string;
}

/** Rows folded under one head. Closed, the head carries `badge`, or else the sum of its rows' counts. */
export interface NavItemGroup {
  key: string;
  label: string;
  icon: IconName;
  items: NavItem[];
  badge?: number;
  /** Open until the reader closes it; a group holding the current page is open regardless. */
  defaultOpen?: boolean;
}

export type NavEntry = NavItem | NavItemGroup;

export const isNavGroup = <E extends NavEntry>(e: E): e is Extract<E, NavItemGroup> => "items" in e;

export interface NavRailProps {
  /** The 88px rail of icons over short labels; otherwise the 280px labelled rail. Both draw the same entries. */
  compact?: boolean;
  workspaceItems: NavEntry[];
  /** The project tier, drawn above the workspace tier; absent or empty hides it. */
  projectItems?: NavEntry[];
  activeKey: string;
  onNavigate?: (key: string) => void;
  /** The reader's open/closed choice per group key. */
  groupOpen?: Record<string, boolean>;
  onToggleGroup?: (key: string, open: boolean) => void;
  projectSwitcher?: React.ReactNode;
  orgSwitcher?: React.ReactNode;
  search?: React.ReactNode;
  bell?: React.ReactNode;
  version?: React.ReactNode;
  user?: { initials: string };
  onAccount?: () => void;
  onSignOut?: () => void;
  onToggleCollapsed?: () => void;
}

const countOf = (n: number | undefined) => (n && n > 0 ? n : 0);
const shown = (n: number) => (n > 99 ? "99+" : String(n));
const FOCUS = "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";

function Count({ n, compact }: { n: number; compact: boolean }) {
  if (n <= 0) return null;
  return compact ? (
    <span
      className="absolute right-2 top-3px inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-pill px-[3px] font-mono text-9 font-bold text-white"
      style={{ background: "var(--accent)", border: "1.5px solid var(--bg-surface)" }}
    >
      {shown(n)}
    </span>
  ) : (
    <span
      className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
      style={{ fontSize: "var(--text-11)", lineHeight: "16px", color: "var(--flame-700)", background: "var(--flame-50)" }}
    >
      {shown(n)}
    </span>
  );
}

function Leading({ item, active, size }: { item: NavItem; active: boolean; size: number }) {
  if (item.mark) {
    return (
      <span
        aria-hidden
        className="grid h-[18px] min-w-[18px] flex-none place-items-center rounded-[5px] px-0.5 font-bold"
        style={{ fontSize: "var(--text-8-5)", background: "var(--cobalt-50)", color: "var(--cobalt-700)" }}
      >
        {item.mark}
      </span>
    );
  }
  return <Icon name={item.icon} size={size} style={active ? { color: "var(--accent)" } : undefined} />;
}

function Row({
  item,
  active,
  compact,
  nested = false,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  compact: boolean;
  nested?: boolean;
  onClick: () => void;
}) {
  const count = countOf(item.badge);
  const hint = count > 0 ? item.badgeHint : undefined;
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-current={active ? "page" : undefined}
        aria-label={hint ?? item.label}
        title={hint ?? item.label}
        className={cn(
          "relative flex flex-col items-center gap-1 rounded-md px-1 pb-1.5 pt-2 transition-colors duration-[120ms]",
          nested ? "w-[64px]" : "w-[76px]",
          FOCUS,
          active ? "bg-accent-tint" : "text-subtle hover:bg-hover",
        )}
      >
        {active && (
          <span
            aria-hidden
            className="absolute bottom-[9px] left-[-6px] top-[9px] w-[3px] rounded-r-3"
            style={{ background: "var(--accent)" }}
          />
        )}
        <Leading item={item} active={active} size={20} />
        <span
          className={cn(
            "block min-w-0 max-w-full truncate text-10 font-semibold tracking-[-0.01em]",
            active ? "text-accent-text" : "text-muted",
          )}
        >
          {item.label}
        </span>
        <Count n={count} compact />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      title={hint}
      className={cn(
        "flex w-full items-center rounded-md transition-colors duration-[120ms] max-md:min-h-[44px]",
        nested ? "gap-2 px-2 py-1.5 text-13 font-medium" : "gap-2.5 px-2.5 py-2 text-13-5 font-semibold",
        FOCUS,
        active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Leading item={item} active={active} size={nested ? 15 : 17} />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      <Count n={count} compact={false} />
    </button>
  );
}

function Group({
  group,
  compact,
  activeKey,
  open,
  onToggle,
  onNavigate,
}: {
  group: NavItemGroup;
  compact: boolean;
  activeKey: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: (key: string) => void;
}) {
  const within = group.items.some((it) => it.key === activeKey);
  const folded = open ? 0 : group.items.reduce((n, it) => n + countOf(it.badge), 0);
  const count = group.badge ?? folded;
  const chevron = (size: number) => (
    <Icon name="chevronDown" size={size} className={cn("text-subtle transition-transform", !open && "-rotate-90")} />
  );
  const rows = group.items.map((it) => (
    <Row key={it.key} item={it} active={it.key === activeKey} compact={compact} nested onClick={() => onNavigate(it.key)} />
  ));
  if (compact) {
    return (
      <div className="flex w-[76px] flex-col items-center" data-testid={`rail-group-${group.key}`}>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={group.label}
          title={group.label}
          className={cn(
            "relative flex w-[76px] flex-col items-center gap-1 rounded-md px-1 pb-1.5 pt-2 text-subtle transition-colors duration-[120ms] hover:bg-hover",
            FOCUS,
          )}
        >
          <span className="flex items-center gap-0.5">
            <Icon name={group.icon} size={18} style={within ? { color: "var(--accent)" } : undefined} />
            {chevron(11)}
          </span>
          <span className="block min-w-0 max-w-full truncate text-10 font-semibold tracking-[-0.01em] text-fg">{group.label}</span>
          <Count n={count} compact />
        </button>
        {open && <div className="ml-2.5 flex flex-col items-center gap-3px border-l border-line-subtle pl-0.5">{rows}</div>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5" data-testid={`rail-group-${group.key}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-13-5 font-semibold transition-colors duration-[120ms] max-md:min-h-[44px]",
          FOCUS,
          within ? "text-fg" : "text-muted hover:bg-hover hover:text-fg",
        )}
      >
        <Icon name={group.icon} size={17} style={within ? { color: "var(--accent)" } : undefined} />
        <span className="flex-1 text-left">{group.label}</span>
        <Count n={count} compact={false} />
        {chevron(14)}
      </button>
      {open && <div className="ml-[19px] flex flex-col gap-0.5 border-l border-line-subtle pl-2">{rows}</div>}
    </div>
  );
}

function Footer({
  compact,
  user,
  onAccount,
  onSignOut,
  onToggleCollapsed,
  version,
}: Pick<NavRailProps, "user" | "onAccount" | "onSignOut" | "onToggleCollapsed" | "version"> & { compact: boolean }) {
  const items: MenuItem[] = [];
  if (onAccount) items.push({ label: "Account & Settings", icon: "settings", onSelect: onAccount });
  if (onSignOut) items.push({ label: "Sign out", icon: "logOut", danger: true, onSelect: onSignOut });
  const chip = (
    <button
      type="button"
      aria-label="Account menu"
      aria-haspopup={items.length > 0 ? "menu" : undefined}
      className={cn(
        "flex items-center rounded-md transition-colors hover:bg-hover max-md:min-h-[44px]",
        FOCUS,
        compact ? "p-1" : "w-full gap-2.5 px-1.5 py-1.5",
      )}
    >
      <span
        className="inline-flex size-7 flex-none items-center justify-center rounded-pill font-bold"
        style={{ background: "var(--cobalt-100)", color: "var(--cobalt-700)", fontSize: "var(--text-12)" }}
      >
        {user?.initials ?? <Icon name="user" size={15} />}
      </span>
      {!compact && (
        <>
          <span className="fg-body-sm flex-1 text-left text-fg">You</span>
          <Icon name="more" size={16} className="text-subtle" />
        </>
      )}
    </button>
  );
  const toggle = compact ? "Expand sidebar" : "Collapse sidebar";
  return (
    <div className="mt-auto flex w-full flex-col gap-1 border-t border-line-subtle pt-3">
      <div className={cn("flex items-center", compact ? "justify-center gap-0.5" : "gap-1")}>
        <div className={cn(!compact && "min-w-0 flex-1")}>
          {items.length > 0 ? (
            <Menu trigger={chip} items={items} side="top" align="left" className="w-full" triggerClassName="block w-full" />
          ) : (
            chip
          )}
        </div>
        {onToggleCollapsed && (
          <Tooltip label={toggle} side="top">
            <button
              type="button"
              onClick={onToggleCollapsed}
              aria-label={toggle}
              className="inline-flex size-8 flex-none items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg max-md:size-11"
            >
              <Icon name="panelLeft" size={16} />
            </button>
          </Tooltip>
        )}
      </div>
      {version && <div className={compact ? "w-full px-0.5" : "px-1.5 pt-1"}>{version}</div>}
    </div>
  );
}

/** The left navigation: project tier over workspace tier, labelled or compact. Presentational — open groups and the collapsed choice belong to the caller. */
export function NavRail({
  compact = false,
  workspaceItems,
  projectItems,
  activeKey,
  onNavigate,
  groupOpen,
  onToggleGroup,
  projectSwitcher,
  orgSwitcher,
  search,
  bell,
  ...footer
}: NavRailProps) {
  const go = (key: string) => onNavigate?.(key);
  const entry = (e: NavEntry) => {
    if (!isNavGroup(e)) {
      return <Row key={e.key} item={e} active={e.key === activeKey} compact={compact} onClick={() => go(e.key)} />;
    }
    const chosen = groupOpen?.[e.key] ?? e.defaultOpen ?? false;
    return (
      <Group
        key={e.key}
        group={e}
        compact={compact}
        activeKey={activeKey}
        open={chosen || e.items.some((it) => it.key === activeKey)}
        onToggle={() => onToggleGroup?.(e.key, !chosen)}
        onNavigate={go}
      />
    );
  };
  const tier = (label: string, entries: NavEntry[]) => (
    <div className={cn("flex flex-col", compact ? "items-center gap-3px" : "gap-1")}>
      {compact ? (
        <span className="select-none px-1 pb-0.5 text-center text-8-5 font-semibold uppercase leading-none tracking-[0.08em] text-subtle">
          {label}
        </span>
      ) : (
        <Kicker className="px-2.5 pb-1">{label}</Kicker>
      )}
      {entries.map(entry)}
    </div>
  );

  return (
    <nav
      className={cn(
        "flex h-full flex-none flex-col border-r border-line bg-surface",
        compact ? "w-[88px] items-center gap-2.5 px-1.5 pb-3 pt-[14px]" : "w-[280px] gap-3.5 px-3 py-4",
      )}
    >
      <div data-testid="brand-row" className={cn("flex items-center gap-1.5", !compact && "px-1")}>
        {/* biome-ignore lint/performance/noImgElement: a fixed-size brand mark under the base path; next/image would lazy-load and wrap it */}
        <img
          src={assetPath("/forge-mark-32.png")}
          width={28}
          height={28}
          alt="Forge"
          className="size-7 flex-none rounded-md"
          draggable={false}
        />
        {!compact && orgSwitcher}
        {!compact && search}
        {bell}
      </div>
      {compact && orgSwitcher}
      {compact && search}
      {projectSwitcher}
      <div
        data-testid="rail-tiers"
        className={cn("flex min-h-0 w-full flex-1 flex-col overflow-y-auto", compact ? "items-center gap-3" : "gap-5")}
      >
        {projectItems && projectItems.length > 0 && tier("Project", projectItems)}
        {tier(compact ? "Space" : "Workspace", workspaceItems)}
      </div>
      <Footer compact={compact} {...footer} />
    </nav>
  );
}
