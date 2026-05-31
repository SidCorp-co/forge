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
}

/** A titled group of project-tier nav items (e.g. Work / Insight / Config). */
export interface NavCluster {
  key: string;
  kicker: string;
  items: NavItem[];
  /** When true the header gets a chevron and can be collapsed. */
  collapsible?: boolean;
}

export interface NavRailProps {
  workspaceItems: NavItem[];
  /** Flat project items (kit / fallback). Ignored when `projectClusters` is set. */
  projectItems?: NavItem[];
  /** Grouped project nav. Preferred over `projectItems` when present. */
  projectClusters?: NavCluster[];
  activeKey: string;
  onNavigate?: (key: string) => void;
  /** Opens the searchable project switcher (the command palette). */
  onProjectSwitch?: () => void;
  /** Jump to the Docs page (pinned bottom-left). */
  onDocs?: () => void;
  /** Footer user-menu actions. When set, the user chip becomes an actionable
   *  menu (Account / Settings, Sign out) instead of a dead element. */
  onAccount?: () => void;
  onSignOut?: () => void;
  project?: { name: string; initials: string; tint: string; ink: string };
  user?: { initials: string };
  /** Icon-only collapsed rail. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Per-cluster open map (key ⇒ open). Missing/undefined ⇒ open. */
  groupOpen?: Record<string, boolean>;
  onToggleGroup?: (key: string) => void;
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
  const btn = (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={undefined}
      className={cn(
        "flex w-full items-center rounded-md text-[13.5px] font-semibold transition-colors duration-[120ms]",
        // ≥44px touch target on small screens (drawer); compact on desktop rail.
        "max-md:min-h-[44px]",
        collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-2.5 py-2",
        active ? "bg-accent-tint text-accent-text" : "text-muted hover:bg-hover hover:text-fg",
      )}
    >
      <Icon name={item.icon} size={17} style={active ? { color: "var(--accent)" } : undefined} />
      {!collapsed && item.label}
    </button>
  );
  // Tooltip surfaces the label in icon-only mode — but expanding the rail also
  // reveals labels, so discoverability is NOT hover-dependent.
  return collapsed ? (
    <Tooltip label={item.label} side="bottom">
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
}: {
  cluster: NavCluster;
  activeKey: string;
  collapsed?: boolean;
  open: boolean;
  onToggle?: () => void;
  onNavigate?: (key: string) => void;
}) {
  // In icon-only mode clusters render flat (no header / chevron, always shown).
  if (collapsed) {
    return (
      <div className="flex flex-col gap-1">
        {cluster.items.map((it) => (
          <NavRow key={it.key} item={it} active={it.key === activeKey} collapsed onClick={() => onNavigate?.(it.key)} />
        ))}
      </div>
    );
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
      {open &&
        cluster.items.map((it) => (
          <NavRow key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate?.(it.key)} />
        ))}
    </div>
  );
}

/** Two-tier left nav: Workspace links + a project switcher + clustered project
 *  sub-nav. Presentational — collapse / cluster state is owned by the caller. */
export function NavRail({
  workspaceItems,
  projectItems,
  projectClusters,
  activeKey,
  onNavigate,
  onProjectSwitch,
  onDocs,
  onAccount,
  onSignOut,
  project,
  user,
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
        style={{ background: "var(--cobalt-100)", color: "var(--cobalt-700)", fontSize: 12 }}
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
        "flex h-full flex-none flex-col gap-5 border-r border-line bg-surface py-4 transition-[width] duration-150",
        collapsed ? "w-[60px] px-2" : "w-[232px] px-3",
      )}
    >
      <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-2 px-1.5")}>
        {/* Real Forge brand mark. Plain <img> needs assetPath() so the src is
            prefixed with the /v2 basePath (Next does NOT auto-prefix raw img). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
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
            <span className="fg-h3 flex-1" style={{ fontSize: 16 }}>
              Forge
            </span>
            {onToggleCollapsed && (
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-label="Collapse sidebar"
                className="inline-flex size-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
              >
                <Icon name="panelLeft" size={16} />
              </button>
            )}
          </>
        )}
      </div>

      {collapsed && onToggleCollapsed && (
        <Tooltip label="Expand sidebar" side="bottom">
          <button
            type="button"
            onClick={onToggleCollapsed}
            aria-label="Expand sidebar"
            className="inline-flex w-full items-center justify-center rounded-md py-2 text-subtle transition-colors hover:bg-hover hover:text-fg"
          >
            <Icon name="chevronRight" size={16} />
          </button>
        </Tooltip>
      )}

      <div className="flex flex-col gap-1">
        {!collapsed && <Kicker className="px-2.5 pb-1">Workspace</Kicker>}
        {workspaceItems.map((it) => (
          <NavRow key={it.key} item={it} active={it.key === activeKey} collapsed={collapsed} onClick={() => onNavigate?.(it.key)} />
        ))}
      </div>

      {project && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {collapsed ? (
            <Tooltip label={project.name} side="bottom">
              <button
                type="button"
                onClick={onProjectSwitch}
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
              aria-label="Switch project"
              className="flex items-center gap-2.5 rounded-md border border-line bg-sunken px-2.5 py-2 text-left transition-colors hover:bg-hover"
            >
              <ProjectMark tint={project.tint} ink={project.ink} initials={project.initials} size={26} radius="var(--r-sm)" />
              <span className="fg-label flex-1 truncate">{project.name}</span>
              <Icon name="chevronUpDown" size={15} className="text-subtle" />
            </button>
          )}
          {clusters.map((c) => (
            <Cluster
              key={c.key}
              cluster={c}
              activeKey={activeKey}
              collapsed={collapsed}
              open={groupOpen?.[c.key] !== false}
              onToggle={() => onToggleGroup?.(c.key)}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}

      {/* Footer block: Docs pinned bottom-left, then the user chip. */}
      <div className="mt-auto flex flex-col gap-1 border-t border-line-subtle pt-3">
        {onDocs && (
          <NavRow
            item={{ key: "docs", label: "Docs", icon: "book" }}
            active={activeKey === "docs"}
            collapsed={collapsed}
            onClick={onDocs}
          />
        )}
        <div className={cn("flex items-center pt-1", collapsed ? "justify-center" : "")}>{userArea}</div>
      </div>
    </nav>
  );
}
