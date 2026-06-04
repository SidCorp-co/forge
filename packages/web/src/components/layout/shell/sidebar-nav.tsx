'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils/cn';
import type { Project } from '@forge/contracts';
import { useProjects } from '@/features/project/hooks/use-projects';
import { useWebSocket } from '@/hooks/use-websocket';
import { useAuth } from '@/providers/auth-provider';
import {
  LayoutDashboard,
  GitMerge,
  MessageSquare,
  FolderOpen,
  Settings,
  LogOut,
  ChevronDown,
  ChevronUp,
  Plus,
  X,
  Sun,
  Moon,
  LifeBuoy,
  Bell,
  BookOpen,
} from 'lucide-react';
import { useWhatsNewStatus } from '@/features/whats-new/hooks';
import { useThemePreference } from '@/hooks/use-theme-preference';
import { useMounted } from '@/hooks/use-mounted';
import Image from 'next/image';
import logoImg from '../../../../public/180x180.png';
import { NotificationBell } from '@/features/notification/components/notification-bell';
import { NOTIFICATIONS_ENABLED } from '@/features/notification';

const PROJECT_SUB_LINKS = [
  { path: '', label: 'Overview' },
  { path: '/issues', label: 'Issues' },
  { path: '/board', label: 'Board' },
  { path: '/agent', label: 'Chat' },
  { path: '/agents', label: 'Agents' },
  { path: '/skills', label: 'Skills' },
  { path: '/knowledge', label: 'Knowledge' },
  { path: '/memory', label: 'Memory' },
  { path: '/schedules', label: 'Schedules' },
  { path: '/pm', label: 'PM Agent' },
  { path: '/settings', label: 'Settings' },
];

function AvatarDropdown({ user, connected, logout, pathname }: {
  user: { email?: string } | null | undefined;
  connected: boolean;
  logout: () => void;
  pathname: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const displayName = user?.email ? user.email.split('@')[0] : 'Signed in';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={user?.email}
        className="w-full flex items-center gap-3 px-3 py-2 rounded-sm hover:bg-surface-container-low transition-colors"
      >
        <div className="w-8 h-8 rounded-full bg-surface-container-high border border-outline-variant/30 flex items-center justify-center shrink-0">
          <span className="text-xs font-bold text-primary uppercase">{user?.email?.[0]?.toUpperCase() || 'U'}</span>
        </div>
        <div className="overflow-hidden flex-1 min-w-0 text-left">
          <p className="text-xs font-semibold truncate text-primary">{displayName}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', connected ? 'bg-success' : 'bg-danger')}
              title={connected ? 'Connected' : 'Offline'}
            />
            <span className="text-[10px] text-on-surface-variant truncate uppercase tracking-widest">{connected ? 'System Online' : 'Connecting'}</span>
          </div>
        </div>
        <ChevronUp className={cn('h-3.5 w-3.5 text-outline transition-transform', open ? 'rotate-0' : 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-sm border border-outline-variant/30 bg-surface-container-low shadow-lg py-1">
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className={cn(
              'flex items-center gap-3 px-4 py-2 text-sm transition-colors',
              pathname === '/settings' ? 'text-primary font-semibold' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
            )}
          >
            <Settings className="h-4 w-4" />
            <span>Settings</span>
          </Link>
          <button
            onClick={() => { setOpen(false); logout(); }}
            className="w-full flex items-center gap-3 px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container-high hover:text-error transition-colors text-left"
          >
            <LogOut className="h-4 w-4" />
            <span>Logout</span>
          </button>
        </div>
      )}
    </div>
  );
}

function FeedbackButton() {
  const openHelpdesk = () => {
    const fab = document.querySelector<HTMLButtonElement>(
      '#sid-desk-widget-root .sid-fab'
    );
    if (fab) {
      fab.click();
      return;
    }
    // Script may not have finished bootstrapping; poll briefly.
    let tries = 0;
    const id = window.setInterval(() => {
      tries += 1;
      const el = document.querySelector<HTMLButtonElement>(
        '#sid-desk-widget-root .sid-fab'
      );
      if (el) {
        window.clearInterval(id);
        el.click();
      } else if (tries > 20) {
        window.clearInterval(id);
      }
    }, 150);
  };

  return (
    <button
      onClick={openHelpdesk}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-sm text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors"
      title="Send feedback or chat with support"
      aria-label="Feedback"
    >
      <LifeBuoy className="h-4 w-4" />
      <span className="text-xs">Feedback</span>
    </button>
  );
}

function ThemeToggle() {
  const { resolvedTheme, saveTheme } = useThemePreference();
  const mounted = useMounted();
  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <button
      onClick={() => saveTheme(isDark ? 'light' : 'dark')}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-sm text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface transition-colors"
      title={mounted ? (isDark ? 'Switch to light mode' : 'Switch to dark mode') : 'Theme'}
      aria-label="Toggle theme"
      suppressHydrationWarning
    >
      {/* Render a stable placeholder until mounted so SSR/hydration markup matches; theme-dependent icon swaps in afterwards. */}
      <span className="h-4 w-4 inline-flex items-center justify-center" suppressHydrationWarning>
        {!mounted ? <Moon className="h-4 w-4 opacity-0" /> : isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
      </span>
      <span className="text-xs" suppressHydrationWarning>{!mounted ? ' ' : isDark ? 'Light Mode' : 'Dark Mode'}</span>
    </button>
  );
}

function ProjectSubLinks({ href, pathname, projectSlug: _projectSlug }: { href: string; pathname: string; projectSlug: string }) {
  // useGateIssues was a Strapi-only aggregate. Phase 2.6-F2 hides the badge
  // until the admin/gate aggregation ships on packages/core.
  const gateCount = 0;

  return (
    <div className="ml-7 border-l-2 border-surface-container-high pl-2 mt-1 mb-2">
      {PROJECT_SUB_LINKS.map((sub) => {
        const subHref = `${href}${sub.path}`;
        const isSubActive = pathname === subHref;
        return (
          <Link
            key={sub.path}
            href={subHref}
            className={cn(
              'flex items-center gap-1.5 rounded-sm px-2 py-1.5 text-[11px] font-medium transition-colors',
              isSubActive ? 'bg-surface-container-high text-primary' : 'text-outline hover:text-tertiary hover:bg-surface-container-low'
            )}
          >
            {sub.label}
            {sub.label === 'Overview' && gateCount > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-bold text-white">
                {gateCount}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

interface SidebarNavProps {
  onClose: () => void;
}

export function SidebarNav({ onClose }: SidebarNavProps) {
  const pathname = usePathname();
  const { data: projectsData } = useProjects();
  const { user, logout } = useAuth();
  const { connected } = useWebSocket();
  const { hasUnseen: whatsNewUnseen } = useWhatsNewStatus();
  const [projectsOpen, setProjectsOpen] = useState(true);

  const projects: Project[] = projectsData ?? [];

  return (
    <div className="flex h-full flex-col bg-surface font-['Inter'] tracking-tight text-sm antialiased overflow-hidden">
      {/* Mobile Header elements (X button and Bell) */}
      <div className="flex items-center justify-between px-4 py-2 md:hidden">
        {NOTIFICATIONS_ENABLED ? <NotificationBell align="left" /> : <span />}
        <button
          onClick={onClose}
          className="rounded p-2 text-outline hover:text-on-surface"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="px-4 md:px-6 mb-3 md:mb-6 mt-3 md:mt-6 flex items-center gap-3">
        <Image src={logoImg} alt="Forge" width={32} height={32} className="rounded-sm" />
        <div>
          <h1 className="text-lg font-bold tracking-widest uppercase text-primary leading-none">Forge</h1>
          <p className="text-[10px] text-on-surface-variant uppercase tracking-tighter opacity-60">Precision Engine</p>
        </div>
      </div>

      <div className="px-4 mb-6 hidden md:block">
        <Link href="/projects?new=1" className="w-full bg-primary text-on-primary py-2 px-4 rounded-sm flex items-center justify-center gap-2 font-semibold text-xs transition-all active:scale-[0.98] hover:bg-tertiary">
          <Plus className="h-4 w-4" />
          New Project
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-3 overflow-y-auto hide-scrollbar pb-4">
        {/* Active Navigation: Dashboard */}
        <Link
          href="/dashboard"
          className={cn(
            'flex items-center gap-3 px-3 py-2 transition-all duration-150',
            pathname === '/dashboard' ? 'bg-surface-variant text-primary font-semibold border-l-2 border-primary' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface border-l-2 border-transparent'
          )}
        >
          <LayoutDashboard className="h-[18px] w-[18px]" />
          <span>Dashboard</span>
        </Link>

        <div>
          <Link
            href="/pipeline"
            className={cn(
              'flex items-center gap-3 px-3 py-2 transition-all duration-150',
              pathname.startsWith('/pipeline') ? 'bg-surface-variant text-primary font-semibold border-l-2 border-primary' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface border-l-2 border-transparent'
            )}
          >
            <GitMerge className="h-[18px] w-[18px]" />
            <span>Pipeline</span>
          </Link>
          {pathname.startsWith('/pipeline') && (
            <div className="ml-7 border-l-2 border-surface-container-high pl-2 mt-1 mb-2">
              <Link
                href="/pipeline"
                className={cn(
                  'block rounded-sm px-2 py-1.5 text-[11px] font-medium transition-colors',
                  pathname === '/pipeline' ? 'bg-surface-container-high text-primary' : 'text-outline hover:text-tertiary hover:bg-surface-container-low'
                )}
              >
                Monitor
              </Link>
              <Link
                href="/pipeline/progress"
                className={cn(
                  'block rounded-sm px-2 py-1.5 text-[11px] font-medium transition-colors',
                  pathname === '/pipeline/progress' ? 'bg-surface-container-high text-primary' : 'text-outline hover:text-tertiary hover:bg-surface-container-low'
                )}
              >
                Progress
              </Link>
              <Link
                href="/pipeline/health"
                className={cn(
                  'block rounded-sm px-2 py-1.5 text-[11px] font-medium transition-colors',
                  pathname === '/pipeline/health' ? 'bg-surface-container-high text-primary' : 'text-outline hover:text-tertiary hover:bg-surface-container-low'
                )}
              >
                Health
              </Link>
            </div>
          )}
        </div>

        {user?.chatLogAccess && (
          <Link
            href="/chat-logs"
            className={cn(
              'flex items-center gap-3 px-3 py-2 transition-all duration-150',
              pathname.startsWith('/chat-logs') ? 'bg-surface-variant text-primary font-semibold border-l-2 border-primary' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface border-l-2 border-transparent'
            )}
          >
            <MessageSquare className="h-[18px] w-[18px]" />
            <span>Chat Logs</span>
          </Link>
        )}

        <Link
          href="/whats-new"
          className={cn(
            'flex items-center gap-3 px-3 py-2 transition-all duration-150',
            pathname.startsWith('/whats-new') ? 'bg-surface-variant text-primary font-semibold border-l-2 border-primary' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface border-l-2 border-transparent'
          )}
        >
          <Bell className="h-[18px] w-[18px]" />
          <span>What&apos;s New</span>
          {whatsNewUnseen && (
            <span
              className="ml-auto h-2 w-2 rounded-full bg-primary"
              aria-label="New updates"
              title="New updates"
            />
          )}
        </Link>

        <Link
          href="/docs"
          className={cn(
            'flex items-center gap-3 px-3 py-2 transition-all duration-150',
            pathname.startsWith('/docs') ? 'bg-surface-variant text-primary font-semibold border-l-2 border-primary' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface border-l-2 border-transparent'
          )}
        >
          <BookOpen className="h-[18px] w-[18px]" />
          <span>Help &amp; Docs</span>
        </Link>

        <div className="pt-2">
          <button
            onClick={() => setProjectsOpen(!projectsOpen)}
            className="w-full flex items-center justify-between px-3 py-2 text-[10px] uppercase tracking-widest text-on-surface-variant/50 font-bold hover:text-on-surface-variant transition-colors"
          >
            Projects
            {projectsOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
          
          {projectsOpen && (
            <div className="mt-1 space-y-0.5">
              {projects.map((p) => {
                const href = `/projects/${p.slug}`;
                const active = pathname.startsWith(href);
                return (
                  <div key={p.id}>
                    <Link
                      href={href}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2 transition-all duration-150 group',
                        active ? 'bg-surface-variant text-primary font-semibold border-l-2 border-primary' : 'text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface border-l-2 border-transparent'
                      )}
                    >
                      <FolderOpen className={cn("h-[18px] w-[18px]", active ? "text-primary" : "text-on-surface-variant group-hover:text-on-surface")} />
                      <span className="truncate">{p.name}</span>
                    </Link>
                    {active && (
                      <ProjectSubLinks href={href} pathname={pathname} projectSlug={p.slug} />
                    )}
                  </div>
                );
              })}
              {projects.length === 0 && (
                <p className="px-3 py-2 pl-9 text-xs text-outline-variant">No active projects</p>
              )}
            </div>
          )}
        </div>

      </nav>

      <div className="mt-auto px-3 pt-3 md:pt-6 pb-3 md:pb-6 border-t border-outline-variant/20 space-y-2">
        <FeedbackButton />
        <ThemeToggle />
        <AvatarDropdown user={user} connected={connected} logout={logout} pathname={pathname} />
      </div>
    </div>
  );
}
