"use client";

import { cn } from "@/lib/utils/cn";
import { assetPath } from "@/lib/asset";
import { Icon, type IconName } from "@/design/icons/icon";
import { Kicker } from "@/design/primitives/kicker";
import { Tooltip } from "@/design/primitives/tooltip";
import { ProjectMark } from "@/design/primitives/project-mark";
import { Menu, type MenuItem } from "./menu";

export interface NavItem {
  key: string;
  label: string;
  icon: IconName;
  /** Optional count pill (e.g. the Attention/Inbox unread count). Rendered as a
   *  small badge beside the label, or as a count dot on the icon when collapsed.
   *  Falsy / 0 hides it. */
  badge?: number;
}

export interface NavItemGroup {
  key: string;
  label: string;
  icon: NavItem["icon"];
  items: NavItem[];
}

export type NavEntry = NavItem | NavItemGroup;

const isNavGroup = (e: NavEntry): e is NavItemGroup => "items" in e;

/** A titled group of project-tier nav items (e.g. Work / Insight / Config). */
export interface NavCluster {
  key: string;
  kicker: string;
  items: NavEntry[];
  /** When true the header gets a chevron and can be collapsed. */
  collapsible?: boolean;
}

export interface NavRailProps {
  workspaceItems: NavItem[];
  /** Flat project items (kit / fallback). Ignored when `projectClusters` is set. */
  projectItems?: NavItem[];
  /** Grouped project nav. Preferred over `projectItems` when present. */
  projectClusters?: NavCluster[];
  workspaceClusters?: Array<{ key: string; kicker: string; items: NavItem[]; icon?: NavItem["icon"]; collapsible?: boolean }>;
  activeKey: string;
  onNavigate?: (key: string) => void;
  /** Opens the searchable project switcher (the command palette). */
  onProjectSwitch?: () => void;
  /** Hover handlers for the project switcher — open the flyout on enter,
   *  schedule its close on leave. Click (`onProjectSwitch`) + keyboard focus
   *  remain the accessible fallback. */
  onSwitcherEnter?: () => void;
  onSwitcherLeave?: () => void;
  /** Footer user-menu actions. When set, the user chip becomes an actionable
   *  menu (Account / Settings, Sign out) instead of a dead element. */
  onAccount?: () => void;
  onSignOut?: () => void;
  project?: { name: string; initials: string; tint: string; ink: string };
  user?: { initials: string };
  /** The organization picker, on the brand row beside the logo. Hidden while collapsed. */
  orgSwitcher?: React.ReactNode;
  /** The product's own version, pinned to the footer (ISS-1119). Hidden while
   *  collapsed — the compact rail carries it there instead. */
  version?: React.ReactNode;
  search?: React.ReactNode;
  brandSearch?: React.ReactNode;
  /** The notifications bell, at the end of the brand row. */
  bell?: React.ReactNode;
  body?: React.ReactNode;
  /** Icon-only collapsed rail. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Per-cluster open map (key ⇒ open). Missing/undefined ⇒ open. */
  groupOpen?: Record<string, boolean>;
  onToggleGroup?: (key: string, open?: boolean) => void;
}

function NavRow({
  item,
  active,
  collapsed,
  onClick,
}: {
  item: NavItem;
  active: boolean;
  collapsed?: boolean;
  onClick?: () => void;
}) {
  const count = item.badge && item.badge > 0 ? item.badge : 0;
  const badgeLabel = count > 99 ? "99+" : String(count);
  const btn = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={
        collapsed
          ? count > 0
            ? `${item.label}, ${count} need attention`
            : item.label
          : undefined
      }
      title={undefined}
      className={cn(
        "flex w-full items-center rounded-md text-13-5 font-semibold transition-colors duration-[120ms] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        // ≥44px touch target on small screens (drawer); compact on desktop rail.
        "max-md:min-h-[44px]",
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2",
        active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      {collapsed ? (
        // Icon-only: anchor a count dot on the top-right of the glyph.
        <span className="relative inline-flex">
          <Icon name={item.icon} size={17} style={active ? { color: "var(--accent)" } : undefined} />
          {count > 0 && (
            <span
              className="absolute -right-2 -top-1.5 inline-flex min-w-[15px] items-center justify-center rounded-pill px-1 font-semibold"
              style={{ fontSize: "var(--text-9-5)", lineHeight: "14px", color: "var(--flame-700)", background: "var(--flame-50)" }}
            >
              {badgeLabel}
            </span>
          )}
        </span>
      ) : (
        <>
          <Icon name={item.icon} size={17} style={active ? { color: "var(--accent)" } : undefined} />
          <span className="flex-1 text-left">{item.label}</span>
          {count > 0 && (
            <span
              className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
              style={{ fontSize: "var(--text-11)", lineHeight: "16px", color: "var(--flame-700)", background: "var(--flame-50)" }}
            >
              {badgeLabel}
            </span>
          )}
        </>
      )}
    </button>
  );
  // Tooltip surfaces the label in icon-only mode — but expanding the rail also
  // reveals labels, so discoverability is NOT hover-dependent.
  return collapsed ? (
    <Tooltip label={count > 0 ? `${item.label} · ${count}` : item.label} side="bottom">
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

function Cluster({
  cluster,
  activeKey,
  collapsed,
  open,
  onToggle,
  onNavigate,
  groupOpen,
  onToggleGroup,
}: {
  cluster: NavCluster;
  activeKey: string;
  collapsed?: boolean;
  open: boolean;
  onToggle?: () => void;
  onNavigate?: (key: string) => void;
  groupOpen?: Record<string, boolean>;
  onToggleGroup?: (key: string, open?: boolean) => void;
}) {
  const entry = (it: NavEntry, flat: boolean) =>
    isNavGroup(it) ? (
      <NavGroup
        key={it.key}
        cluster={{ key: it.key, kicker: it.label, icon: it.icon, items: it.items }}
        activeKey={activeKey}
        collapsed={flat}
        open={groupOpen?.[it.key] === true || it.items.some((c) => c.key === activeKey)}
        onToggle={() => onToggleGroup?.(it.key, groupOpen?.[it.key] !== true)}
        onNavigate={onNavigate}
      />
    ) : (
      <NavRow key={it.key} item={it} active={it.key === activeKey} collapsed={flat} onClick={() => onNavigate?.(it.key)} />
    );
  if (collapsed) {
    return <div className="flex flex-col gap-1">{cluster.items.map((it) => entry(it, true))}</div>;
  }
  return (
    <div className="flex flex-col gap-1">
      {cluster.collapsible ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex items-center gap-1 rounded-md px-2.5 pb-1 pt-0.5 text-left hover:text-fg"
        >
          <Kicker className="flex-1">{cluster.kicker}</Kicker>
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} className="text-subtle" />
        </button>
      ) : (
        <Kicker className="px-2.5 pb-1">{cluster.kicker}</Kicker>
      )}
      {open && cluster.items.map((it) => entry(it, false))}
    </div>
  );
}

function NavGroup({
  cluster,
  activeKey,
  collapsed,
  open,
  onToggle,
  onNavigate,
}: {
  cluster: { key: string; kicker: string; items: NavItem[]; icon?: NavItem["icon"] };
  activeKey: string;
  collapsed?: boolean;
  open: boolean;
  onToggle?: () => void;
  onNavigate?: (key: string) => void;
}) {
  const within = cluster.items.some((it) => it.key === activeKey);
  if (collapsed) {
    return (
      <>
        {cluster.items.map((it) => (
          <NavRow key={it.key} item={it} active={it.key === activeKey} collapsed onClick={() => onNavigate?.(it.key)} />
        ))}
      </>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-13-5 font-semibold transition-colors duration-[120ms] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]",
          within ? "text-fg" : "text-muted hover:bg-hover hover:text-fg",
        )}
      >
        <Icon name={cluster.icon ?? "ecosystem"} size={17} style={within ? { color: "var(--accent)" } : undefined} />
        <span className="flex-1 text-left">{cluster.kicker}</span>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} className="text-subtle" />
      </button>
      {open && (
        <div className="ml-[19px] flex flex-col gap-0.5 border-l border-line-subtle pl-2">
          {cluster.items.map((it) => {
            const active = it.key === activeKey;
            const count = it.badge && it.badge > 0 ? it.badge : 0;
            return (
              <button
                key={it.key}
                type="button"
                onClick={() => onNavigate?.(it.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-13 font-medium transition-colors duration-[120ms] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-md:min-h-[44px]",
                  active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <Icon name={it.icon} size={15} style={active ? { color: "var(--accent)" } : undefined} />
                <span className="flex-1 text-left">{it.label}</span>
                {count > 0 && (
                  <span
                    className="inline-flex min-w-[18px] items-center justify-center rounded-pill px-1.5 font-semibold"
                    style={{ fontSize: "var(--text-11)", lineHeight: "16px", color: "var(--flame-700)", background: "var(--flame-50)" }}
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Two-tier left nav: Workspace links + a project switcher + clustered project
 *  sub-nav. Presentational — collapse / cluster state is owned by the caller. */
export function NavRail({
  workspaceItems,
  projectItems,
  projectClusters,
  workspaceClusters,
  activeKey,
  onNavigate,
  onProjectSwitch,
  onSwitcherEnter,
  onSwitcherLeave,
  onAccount,
  onSignOut,
  project,
  user,
  orgSwitcher,
  version,
  search,
  brandSearch,
  bell,
  body,
  collapsed = false,
  onToggleCollapsed,
  groupOpen,
  onToggleGroup,
}: NavRailProps) {
  const clusters: NavCluster[] =
    projectClusters ??
    (projectItems && projectItems.length
      ? [{ key: "project", kicker: "Project", items: projectItems }]
      : []);

  // Footer user-menu actions. Theme toggle is intentionally omitted: the app is
  // light-only (forcedTheme), so shipping a toggle would be a dead control.
  const userMenuItems: MenuItem[] = [];
  if (onAccount) userMenuItems.push({ label: "Account & Settings", icon: "settings", onSelect: onAccount });
  if (onSignOut) userMenuItems.push({ label: "Sign out", icon: "logOut", danger: true, onSelect: onSignOut });

  const userChip = (
    <button
      type="button"
      aria-label="Account menu"
      aria-haspopup="menu"
      className={cn(
        "flex items-center rounded-md transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none max-md:min-h-[44px]",
        collapsed ? "w-full justify-center py-1.5" : "w-full gap-2.5 px-1.5 py-1.5",
      )}
    >
      <span
        className="inline-flex size-7 flex-none items-center justify-center rounded-pill font-bold"
        style={{ background: "var(--cobalt-100)", color: "var(--cobalt-700)", fontSize: "var(--text-12)" }}
      >
        {user?.initials ?? "SK"}
      </span>
      {!collapsed && (
        <>
          <span className="fg-body-sm flex-1 text-left text-fg">You</span>
          <Icon name="more" size={16} className="text-subtle" />
        </>
      )}
    </button>
  );
  const userArea =
    userMenuItems.length > 0 ? (
      <Menu
        trigger={userChip}
        items={userMenuItems}
        side="top"
        align="left"
        className="w-full"
        triggerClassName="block w-full"
      />
    ) : (
      userChip
    );

  return (
    <nav
      className={cn(
        "flex h-full flex-none flex-col gap-3.5 border-r border-line bg-surface py-4 transition-[width] duration-150",
        collapsed ? "w-[60px] px-2" : "w-[280px] px-3",
      )}
    >
      <div data-testid="brand-row" className={cn("flex items-center", collapsed ? "justify-center" : "gap-1.5 px-1")}>
        {/* Real Forge brand mark. Plain <img> needs assetPath() so the src is
            prefixed with the /v2 basePath (Next does NOT auto-prefix raw img). */}
        <img
          src={assetPath("/forge-mark-32.png")}
          width={28}
          height={28}
          alt="Forge"
          className="size-7 flex-none rounded-md"
          draggable={false}
        />
        {!collapsed && (
          <>
            {orgSwitcher}
            {brandSearch}
            {bell}
          </>
        )}
      </div>

      {search}

      {body ?? (
        <>
      {/* Project-first (ISS-358): the switcher is pinned directly under the
          brand, with the PROJECT cluster above the WORKSPACE cluster. */}
      {project && (
        <div onMouseEnter={onSwitcherEnter} onMouseLeave={onSwitcherLeave}>
          {collapsed ? (
            <Tooltip label={project.name} side="bottom">
              <button
                type="button"
                onClick={onProjectSwitch}
                aria-haspopup="dialog"
                aria-label="Switch project"
                className="flex w-full items-center justify-center rounded-md border border-line bg-sunken py-1.5 transition-colors hover:bg-hover"
              >
                <ProjectMark tint={project.tint} ink={project.ink} initials={project.initials} size={24} radius="var(--r-sm)" />
              </button>
            </Tooltip>
          ) : (
            <button
              type="button"
              onClick={onProjectSwitch}
              aria-haspopup="dialog"
              aria-label="Switch project"
              className="flex w-full items-center gap-2.5 rounded-md border border-line bg-sunken px-2.5 py-2 text-left transition-colors hover:bg-hover"
            >
              <ProjectMark tint={project.tint} ink={project.ink} initials={project.initials} size={26} radius="var(--r-sm)" />
              <span className="fg-label flex-1 truncate">{project.name}</span>
              <Icon name="chevronUpDown" size={15} className="text-subtle" />
            </button>
          )}
        </div>
      )}

      {/* Scroll region: PROJECT clusters on top, WORKSPACE cluster demoted
          below. The switcher above stays pinned. */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
        {project && clusters.length > 0 && (
          <div className="flex flex-col gap-3">
            {clusters.map((c) => (
              <Cluster
                key={c.key}
                cluster={c}
                activeKey={activeKey}
                collapsed={collapsed}
                open={groupOpen?.[c.key] !== false}
                onToggle={() => onToggleGroup?.(c.key)}
                onNavigate={onNavigate}
                groupOpen={groupOpen}
                onToggleGroup={onToggleGroup}
              />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-1">
          {!collapsed && <Kicker className="px-2.5 pb-1">Workspace</Kicker>}
          {workspaceItems.map((it) => (
            <NavRow key={it.key} item={it} active={it.key === activeKey} collapsed={collapsed} onClick={() => onNavigate?.(it.key)} />
          ))}
          {workspaceClusters?.map((c) => (
            <NavGroup
              key={c.key}
              cluster={c}
              activeKey={activeKey}
              collapsed={collapsed}
              open={groupOpen?.[c.key] !== false || c.items.some((it) => it.key === activeKey)}
              onToggle={() => onToggleGroup?.(c.key)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      </div>
        </>
      )}

      {/* cm:why the footer is the account control with the collapse handle beside it, then the version, which is the way to What's New and carries the Docs button (ISS-49) */}
      <div className="mt-auto flex flex-col gap-1 border-t border-line-subtle pt-3">
        <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
          <div className="min-w-0 flex-1">{userArea}</div>
          {onToggleCollapsed && (
            <Tooltip label={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="top">
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
                className="inline-flex size-8 flex-none items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg max-md:size-11"
              >
                <Icon name={collapsed ? "chevronRight" : "panelLeft"} size={16} />
              </button>
            </Tooltip>
          )}
        </div>
        {!collapsed && version && <div className="px-1.5 pt-1">{version}</div>}
      </div>
    </nav>
  );
}
