'use client';

// Concept C — the compact 88px icon Rail (default nav). Two centered tiers
// (Workspace · Project) split by a hairline, each item an icon over a 10px
// label that truncates inside its 76px button and never runs past it. The
// active row gets a flame tint + a 3px accent bar pinned to the rail's left
// edge. The project mark opens a searchable switcher flyout on
// hover (pinned-first, pin toggles), anchored to the right of the rail.
//
// Presentational: all data + navigation handlers are passed in by the workspace
// layout (the single routing source of truth). Display prefs (labels / badges)
// live in `useRailPrefs` and are toggled from the account menu.
import { Icon, type IconName } from '@/design/icons/icon';
import { Menu, type MenuItem } from '@/design/patterns/menu';
import { assetPath } from '@/lib/asset';
import { cn } from '@/lib/utils/cn';
import { RailProjectSwitcher } from './rail-project-switcher';

export interface RailItem {
  key: string;
  label: string;
  icon: IconName;
  /** Count pill on actionable queues (Issues / Agents). Falsy/0 hides it. */
  badge?: number;
  /** What the count means, for its tooltip. */
  badgeHint?: string;
}

/** A titled run of project rows the rail folds under one head (Development). */
interface RailGroup {
  key: string;
  label: string;
  icon: IconName;
  items: RailItem[];
}

export type RailEntry = RailItem | RailGroup;

const isRailGroup = (e: RailEntry): e is RailGroup => "items" in e;

export interface SwitcherProject {
  id: string;
  slug: string;
  name: string;
  initials: string;
  tint: string;
  ink: string;
  liveRuns: number;
  pinned: boolean;
}

interface NavRailCompactProps {
  workspaceItems: RailItem[];
  /** Project-tier rows and groups — null/empty when no project is active. */
  projectItems?: RailEntry[] | null;
  /** Which groups the reader opened; a group holding the current page is open regardless. */
  groupOpen?: Record<string, boolean>;
  onToggleGroup?: (key: string, open?: boolean) => void;
  activeKey: string;
  /** Slug of the active project — marks the current row in the switcher. */
  activeSlug?: string | null;
  activeProject?: { name: string; initials: string; tint: string; ink: string; liveRuns: number } | null;
  switcherProjects: SwitcherProject[];
  onNavigate: (key: string) => void;
  onSelectProject: (slug: string) => void;
  onTogglePin: (id: string) => void;
  onAllProjects: () => void;
  onNewProject: () => void;
  onAccount?: () => void;
  onSignOut?: () => void;
  userInitials?: string;
  /** Global org switcher (ISS-469) — rendered under the brand, above the
   *  project switcher. Presentational slot; the layout supplies the control. */
  orgSwitcher?: React.ReactNode;
  /** Switch to the expanded (labeled, 280px) rail; the button sits beside the account menu. */
  onExpand?: () => void;
  /** The product's own version, pinned to the footer. Presentational slot; the
   *  layout supplies the wired node, and only one rail is on screen at a time
   *  so it is never rendered twice (ISS-1119). */
  version?: React.ReactNode;
  search?: React.ReactNode;
  /** The notifications bell, beside the logo. */
  bell?: React.ReactNode;
  ecosystemItems?: RailItem[];
}

/** Tiny centered tier label for the compact rail (ISS-359). The faint hairline
 *  alone read as ambiguous, so each tier (Project · Space) gets an uppercase
 *  kicker scaled down to fit the narrow rail. */
function RailKicker({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "select-none px-1 text-center text-8-5 font-semibold uppercase leading-none tracking-[0.08em] text-subtle",
        className,
      )}
    >
      {label}
    </span>
  );
}

/** The count pill pinned to a rail row's corner; nothing at zero. */
function RailCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      className="absolute right-2 top-3px inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-pill px-[3px] font-mono text-9 font-bold text-white"
      style={{ background: 'var(--accent)', border: '1.5px solid var(--bg-surface)' }}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

function RailButton({
  item,
  active,
  onClick,
  nested,
}: {
  item: RailItem;
  active: boolean;
  onClick: () => void;
  /** A row inside a group: a step narrower, so the group's hairline shows beside it. */
  nested?: boolean;
}) {
  const count = item.badge && item.badge > 0 ? item.badge : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={count > 0 && item.badgeHint ? item.badgeHint : item.label}
      title={count > 0 && item.badgeHint ? item.badgeHint : item.label}
      className={cn(
        'relative flex flex-col items-center gap-1 rounded-md px-1 pb-1.5 pt-2 transition-colors duration-[120ms]',
        nested ? 'w-[64px]' : 'w-[76px]',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        active ? 'bg-accent-tint' : 'text-subtle hover:bg-hover',
      )}
    >
      {active && (
        <span
          aria-hidden
          className="absolute bottom-[9px] left-[-6px] top-[9px] w-[3px] rounded-r-3"
          style={{ background: 'var(--accent)' }}
        />
      )}
      <Icon name={item.icon} size={20} style={active ? { color: 'var(--accent)' } : undefined} />
      <span
        className={cn(
          'block min-w-0 max-w-full truncate text-10 font-semibold tracking-[-0.01em]',
          active ? 'text-accent-text' : 'text-muted',
        )}
      >
        {item.label}
      </span>
      <RailCount count={count} />
    </button>
  );
}

function RailItems({
  items,
  activeKey,
  onNavigate,
}: {
  items: RailItem[];
  activeKey: string;
  onNavigate: (key: string) => void;
}) {
  return (
    <div className="mt-1 flex flex-col items-center gap-3px">
      {items.map((it) => (
        <RailButton key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate(it.key)} />
      ))}
    </div>
  );
}

/** A group head ("Development ▾") over its rows, drawn indented on a hairline while open. Closed,
 *  the head carries the sum of its rows' counts so nothing actionable hides behind the fold. */
function RailGroupBlock({
  group,
  activeKey,
  open,
  onToggle,
  onNavigate,
}: {
  group: RailGroup;
  activeKey: string;
  open: boolean;
  onToggle: () => void;
  onNavigate: (key: string) => void;
}) {
  const folded = open ? 0 : group.items.reduce((n, it) => n + (it.badge && it.badge > 0 ? it.badge : 0), 0);
  return (
    <div className="flex w-[76px] flex-col items-center" data-testid={`rail-group-${group.key}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={group.label}
        title={group.label}
        className="relative flex w-[76px] flex-col items-center gap-1 rounded-md px-1 pb-1.5 pt-2 text-subtle transition-colors duration-[120ms] hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
      >
        <span className="flex items-center gap-0.5">
          <Icon name={group.icon} size={18} />
          <Icon name="chevronDown" size={11} className={cn("transition-transform", !open && "-rotate-90")} />
        </span>
        <span className="block min-w-0 max-w-full truncate text-10 font-semibold tracking-[-0.01em] text-fg">{group.label}</span>
        <RailCount count={folded} />
      </button>
      {open && (
        <div className="ml-2.5 flex flex-col items-center gap-3px border-l border-line-subtle pl-0.5">
          {group.items.map((it) => (
            <RailButton key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate(it.key)} nested />
          ))}
        </div>
      )}
    </div>
  );
}

export function NavRailCompact({
  workspaceItems,
  projectItems,
  activeKey,
  activeSlug,
  activeProject,
  switcherProjects,
  onNavigate,
  onSelectProject,
  onTogglePin,
  onAllProjects,
  onNewProject,
  onAccount,
  onSignOut,
  userInitials,
  orgSwitcher,
  onExpand,
  version,
  search,
  bell,
  ecosystemItems,
  groupOpen,
  onToggleGroup,
}: NavRailCompactProps) {
  const userMenu: MenuItem[] = [];
  if (onAccount) userMenu.push({ label: 'Account & Settings', icon: 'settings', onSelect: onAccount });
  if (onSignOut) userMenu.push({ label: 'Sign out', icon: 'logOut', danger: true, onSelect: onSignOut });

  return (
    <nav className="flex h-full w-[88px] flex-none flex-col items-center border-r border-line bg-surface pb-3 pt-[14px]">
      <div data-testid="brand-row" className="mb-4 flex items-center gap-1.5">
        <img
          src={assetPath('/forge-mark-32.png')}
          width={30}
          height={30}
          alt="Forge"
          className="size-[30px] rounded-md"
          draggable={false}
        />
        {bell}
      </div>

      {orgSwitcher && <div className="mb-3">{orgSwitcher}</div>}

      {search && <div className="mb-2">{search}</div>}

      {projectItems && projectItems.length > 0 && activeProject && (
        <RailProjectSwitcher
          activeProject={activeProject}
          activeSlug={activeSlug}
          switcherProjects={switcherProjects}
          onSelectProject={onSelectProject}
          onTogglePin={onTogglePin}
          onAllProjects={onAllProjects}
          onNewProject={onNewProject}
        />
      )}

      {/* The tiers are the only part of the rail that may outgrow it, so they
          are the only part that scrolls: the brand, the switcher and the footer
          stay pinned to the rail's own box (ISS-1119 — the rail's content runs
          to 999px, and with no scroll region here the footer was laid out past
          the shell's `overflow-hidden` and painted nowhere at 1366x768). The
          switcher is above it rather than in it because `overflow-y-auto`
          computes `overflow-x` to `auto` and would clip its flyout. */}
      <div
        data-testid="rail-tiers"
        className="flex w-full min-h-0 flex-1 flex-col items-center overflow-y-auto"
      >
        {projectItems && projectItems.length > 0 && activeProject && (
          <>
            {/* Project tier. */}
            <RailKicker label="Project" className="mt-1.5" />
            <div className="mt-1 flex flex-col items-center gap-3px">
              {projectItems.map((it) =>
                isRailGroup(it) ? (
                  <RailGroupBlock
                    key={it.key}
                    group={it}
                    activeKey={activeKey}
                    open={groupOpen?.[it.key] === true || it.items.some((c) => c.key === activeKey)}
                    onToggle={() => onToggleGroup?.(it.key, groupOpen?.[it.key] !== true)}
                    onNavigate={onNavigate}
                  />
                ) : (
                  <RailButton key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate(it.key)} />
                ),
              )}
            </div>

            <div className="my-[9px] h-px w-[34px] bg-[color:var(--border-subtle)]" />
          </>
        )}

        {!activeProject && switcherProjects.length === 0 && (
          <>
            <button
              type="button"
              onClick={onNewProject}
              aria-label="Add project"
              className="flex w-[76px] flex-col items-center gap-1 rounded-md pb-1.5 pt-5px text-subtle transition-colors hover:bg-hover"
            >
              <span
                className="inline-flex size-[30px] items-center justify-center rounded-md border border-dashed"
                style={{ borderColor: 'var(--border-default)' }}
              >
                <Icon name="plus" size={16} className="text-subtle" />
              </span>
              <span className="text-10 font-semibold tracking-[-0.01em] text-muted">Add</span>
            </button>

            <div className="my-[11px] h-px w-[34px] bg-[color:var(--border-subtle)]" />
          </>
        )}

        {/* Workspace tier — demoted below the project tier (project-first). */}
        <RailKicker label="Space" />
        <RailItems items={workspaceItems} activeKey={activeKey} onNavigate={onNavigate} />
        {ecosystemItems && ecosystemItems.length > 0 && (
          <>
            <RailKicker label="Ecosystem" className="mt-2.5" />
            <RailItems items={ecosystemItems} activeKey={activeKey} onNavigate={onNavigate} />
          </>
        )}
      </div>

      {/* cm:why the footer is the account menu with the expand handle beside it, then the version, which is the way to What's New and carries the Docs button (ISS-49) */}
      <div className="mt-auto flex w-full flex-col items-center gap-1.5">
        <div className="flex items-center gap-0.5">
          <Menu
            trigger={
              // A real button (not a span) so the account menu is reachable by
              // keyboard (ISS-308 D1).
              <button
                type="button"
                aria-label="Account menu"
                className="inline-flex size-7 items-center justify-center rounded-pill font-bold text-white focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                style={{ background: 'var(--cobalt-500)', fontSize: "var(--text-11)" }}
              >
                {userInitials ?? 'SK'}
              </button>
            }
            items={userMenu}
            side="top"
            align="left"
            triggerClassName="rounded-pill p-1 hover:bg-hover transition-colors"
          />
          {onExpand && (
            <button
              type="button"
              onClick={onExpand}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="inline-flex size-8 items-center justify-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-fg"
            >
              <Icon name="panelLeft" size={16} />
            </button>
          )}
        </div>
        {version && <div className="w-full px-0.5">{version}</div>}
      </div>
    </nav>
  );
}
