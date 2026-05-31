'use client';

// Concept C — the compact 76px icon Rail (default nav). Two centered tiers
// (Workspace · Project) split by a hairline, each item an icon over a 9.5px
// label. The active row gets a flame tint + a 3px accent bar pinned to the
// rail's left edge. The project mark opens a searchable switcher flyout on
// hover (pinned-first, pin toggles), anchored to the right of the rail.
//
// Presentational: all data + navigation handlers are passed in by the workspace
// layout (the single routing source of truth). Display prefs (labels / badges)
// live in `useRailPrefs` and are toggled from the account menu.
import { useCallback, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '@/design/icons/icon';
import { Menu, type MenuItem } from '@/design/patterns/menu';
import { ProjectMark } from '@/design/primitives/project-mark';
import { assetPath } from '@/lib/asset';
import { cn } from '@/lib/utils/cn';

export interface RailItem {
  key: string;
  label: string;
  icon: IconName;
  /** Count pill on actionable queues (Issues / Agents). Falsy/0 hides it. */
  badge?: number;
}

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

export interface NavRailCompactProps {
  workspaceItems: RailItem[];
  /** Project-tier items — null/empty when no project is active. */
  projectItems?: RailItem[] | null;
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
  /** Switch to the expanded (labeled, 232px) rail. */
  onExpand?: () => void;
}

function RailButton({
  item,
  active,
  onClick,
}: {
  item: RailItem;
  active: boolean;
  onClick: () => void;
}) {
  const count = item.badge && item.badge > 0 ? item.badge : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={item.label}
      className={cn(
        'relative flex w-[60px] flex-col items-center gap-1 rounded-md pb-1.5 pt-2 transition-colors duration-[120ms]',
        'focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]',
        active ? 'bg-accent-tint' : 'text-subtle hover:bg-hover',
      )}
    >
      {/* 3px accent bar pinned to the rail's left edge when active. */}
      {active && (
        <span
          aria-hidden
          className="absolute bottom-[9px] left-[-8px] top-[9px] w-[3px] rounded-r-[3px]"
          style={{ background: 'var(--accent)' }}
        />
      )}
      <Icon name={item.icon} size={20} style={active ? { color: 'var(--accent)' } : undefined} />
      <span
        className={cn(
          'text-[9.5px] font-semibold tracking-[-0.01em]',
          active ? 'text-accent-text' : 'text-muted',
        )}
      >
        {item.label}
      </span>
      {count > 0 && (
        <span
          className="absolute right-2 top-[3px] inline-flex h-[15px] min-w-[15px] items-center justify-center rounded-pill px-[3px] font-mono text-[9px] font-bold text-white"
          style={{ background: 'var(--accent)', border: '1.5px solid var(--bg-surface)' }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
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
  onExpand,
}: NavRailCompactProps) {
  const [flyOpen, setFlyOpen] = useState(false);
  const [q, setQ] = useState('');
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setFlyOpen(true);
  }, []);
  const hide = useCallback(() => {
    closeTimer.current = setTimeout(() => setFlyOpen(false), 150);
  }, []);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = term
      ? switcherProjects.filter((p) => p.name.toLowerCase().includes(term))
      : switcherProjects;
    return [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [switcherProjects, q]);

  const userMenu: MenuItem[] = [];
  if (onAccount) userMenu.push({ label: 'Account & Settings', icon: 'settings', onSelect: onAccount });
  if (onSignOut) userMenu.push({ label: 'Sign out', icon: 'logOut', danger: true, onSelect: onSignOut });

  const selectProject = (slug: string) => {
    setFlyOpen(false);
    onSelectProject(slug);
  };

  return (
    <nav className="flex h-full w-[76px] flex-none flex-col items-center border-r border-line bg-surface pb-3 pt-[14px]">
      {/* Brand — doubles as the expand handle. */}
      <button
        type="button"
        onClick={onExpand}
        aria-label={onExpand ? 'Expand sidebar' : 'Forge'}
        className="group mb-4 inline-flex size-[30px] items-center justify-center rounded-md transition-colors hover:bg-hover"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={assetPath('/forge-mark-32.png')}
          width={30}
          height={30}
          alt="Forge"
          className="size-[30px] rounded-md group-hover:opacity-0"
          draggable={false}
        />
        {onExpand && (
          <Icon name="panelLeft" size={18} className="absolute hidden text-subtle group-hover:block" />
        )}
      </button>

      {/* Workspace tier. */}
      <div className="flex flex-col items-center gap-[3px]">
        {workspaceItems.map((it) => (
          <RailButton key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate(it.key)} />
        ))}
      </div>

      {projectItems && projectItems.length > 0 && activeProject && (
        <>
          <div className="my-[11px] h-px w-[34px] bg-[color:var(--border-subtle)]" />

          {/* Project mark — hover opens the switcher flyout. */}
          <div className="relative" onMouseEnter={show} onMouseLeave={hide}>
            <button
              type="button"
              onClick={show}
              aria-haspopup="dialog"
              aria-expanded={flyOpen}
              aria-label={`Switch project — current ${activeProject.name}`}
              className={cn(
                'flex w-[60px] flex-col items-center gap-1 rounded-md pb-1.5 pt-[5px] transition-colors',
                flyOpen ? 'bg-hover' : 'hover:bg-hover',
              )}
            >
              <span className="relative">
                <ProjectMark
                  tint={activeProject.tint}
                  ink={activeProject.ink}
                  initials={activeProject.initials}
                  size={30}
                  radius="var(--r-md)"
                />
                <span
                  className="absolute -bottom-[3px] -right-1 inline-flex size-[15px] items-center justify-center rounded-pill text-subtle"
                  style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-default)' }}
                >
                  <Icon name="chevronUpDown" size={9} strokeWidth={2.4} />
                </span>
              </span>
              {activeProject.liveRuns > 0 && (
                <span className="font-mono text-[9.5px] font-semibold text-accent-text">
                  {activeProject.liveRuns} live
                </span>
              )}
            </button>

            {flyOpen && (
              <div
                role="dialog"
                aria-label="Switch project"
                className="absolute left-[calc(100%+10px)] top-[-6px] z-20 w-64 rounded-lg border border-line bg-surface p-[7px] shadow-[var(--shadow-lg)]"
              >
                {/* Diamond arrow on the left edge. */}
                <span
                  aria-hidden
                  className="absolute left-[-6px] top-[22px] size-[11px] rotate-45"
                  style={{
                    background: 'var(--bg-surface)',
                    borderLeft: '1px solid var(--border-default)',
                    borderBottom: '1px solid var(--border-default)',
                  }}
                />
                <div className="mb-1 flex items-center gap-[7px] border-b border-line-subtle px-2 py-1.5">
                  <Icon name="search" size={14} className="text-subtle" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Find a project…"
                    className="flex-1 border-none bg-transparent py-0.5 text-[13px] text-fg outline-none placeholder:text-disabled"
                  />
                </div>
                <div className="max-h-[300px] overflow-y-auto">
                  {rows.map((p) => (
                    <div
                      key={p.id}
                      className={cn(
                        'flex w-full items-center gap-[9px] rounded-sm px-2 py-[7px]',
                        p.slug === activeSlug ? 'bg-accent-tint' : 'hover:bg-hover',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectProject(p.slug)}
                        className="flex min-w-0 flex-1 items-center gap-[9px] text-left focus-visible:outline-none"
                      >
                        <ProjectMark tint={p.tint} ink={p.ink} initials={p.initials} size={20} radius="var(--r-sm)" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">{p.name}</span>
                        {p.liveRuns > 0 && (
                          <span className="size-1.5 flex-none rounded-pill" style={{ background: 'var(--accent)' }} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => onTogglePin(p.id)}
                        aria-label={p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
                        aria-pressed={p.pinned}
                        className={cn(
                          'flex flex-none rounded-xs p-[3px] transition-colors hover:bg-active',
                          p.pinned ? 'text-accent' : 'text-disabled hover:text-fg',
                        )}
                      >
                        <Icon name="pin" size={14} strokeWidth={p.pinned ? 2.4 : 1.75} />
                      </button>
                    </div>
                  ))}
                  {rows.length === 0 && (
                    <p className="px-2 py-3 text-[13px] text-muted">No projects match.</p>
                  )}
                </div>
                <div className="my-1.5 mx-1 h-px bg-[color:var(--border-subtle)]" />
                <button
                  type="button"
                  onClick={() => { setFlyOpen(false); onAllProjects(); }}
                  className="flex w-full items-center gap-2.5 rounded-sm p-2 text-[13px] font-medium text-fg hover:bg-hover"
                >
                  <Icon name="folder" size={16} className="text-subtle" />
                  All projects
                </button>
                <button
                  type="button"
                  onClick={() => { setFlyOpen(false); onNewProject(); }}
                  className="flex w-full items-center gap-2.5 rounded-sm p-2 text-[13px] font-medium text-fg hover:bg-hover"
                >
                  <Icon name="plus" size={16} className="text-subtle" />
                  New project
                </button>
              </div>
            )}
          </div>

          {/* Project tier. */}
          <div className="mt-1.5 flex flex-col items-center gap-[3px]">
            {projectItems.map((it) => (
              <RailButton key={it.key} item={it} active={it.key === activeKey} onClick={() => onNavigate(it.key)} />
            ))}
          </div>
        </>
      )}

      {/* Footer — account menu only (Devices dropped per product decision). */}
      <div className="mt-auto flex flex-col items-center gap-1.5">
        <Menu
          trigger={
            // A real button (not a span) so the account menu is reachable by
            // keyboard (ISS-308 D1).
            <button
              type="button"
              aria-label="Account menu"
              className="inline-flex size-7 items-center justify-center rounded-pill font-bold text-white focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              style={{ background: 'var(--cobalt-500)', fontSize: 11 }}
            >
              {userInitials ?? 'SK'}
            </button>
          }
          items={userMenu}
          side="top"
          align="left"
          triggerClassName="rounded-pill p-1 hover:bg-hover transition-colors"
        />
      </div>
    </nav>
  );
}
