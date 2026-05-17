'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { ChevronDown, Menu } from 'lucide-react';
import { Shell } from '@/components/layout/shell';
import { cn } from '@/lib/utils/cn';

const TABS = [
  { href: '/settings/account', label: 'Account' },
  { href: '/settings/devices', label: 'Devices' },
  { href: '/settings/tokens', label: 'Tokens' },
  { href: '/settings/mcp', label: 'MCP' },
  { href: '/settings/notifications', label: 'Notifications' },
  { href: '/settings/sessions', label: 'Sessions' },
] as const;

function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function SettingsNav({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-0.5 p-3" role="list">
      {TABS.map((tab) => {
        const active = isActive(pathname, tab.href);
        return (
          <li key={tab.href}>
            <Link
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              onClick={onNavigate}
              className={cn(
                'block rounded-sm px-3 py-2 text-[0.75rem] font-bold uppercase tracking-[0.18em] transition-colors',
                active
                  ? 'bg-surface-container-highest text-primary'
                  : 'text-outline hover:bg-surface-container-low hover:text-on-surface',
              )}
            >
              {tab.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeTab = TABS.find((t) => isActive(pathname, t.href));

  return (
    <Shell>
      <div className="flex h-full min-h-0 flex-1 flex-col md:flex-row">
        <aside
          className="hidden w-56 shrink-0 border-r border-outline-variant/20 bg-surface-dim md:flex md:flex-col"
          aria-label="Settings navigation"
        >
          <SettingsNav pathname={pathname} />
        </aside>

        <div className="border-b border-outline-variant/20 bg-surface-dim md:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen((v) => !v)}
            aria-expanded={mobileOpen}
            aria-controls="settings-mobile-nav"
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="flex items-center gap-2 text-[0.6875rem] font-bold uppercase tracking-[0.2em] text-outline">
              <Menu className="h-3.5 w-3.5" />
              Settings{activeTab ? ` · ${activeTab.label}` : ''}
            </span>
            <ChevronDown
              className={cn(
                'h-4 w-4 text-outline transition-transform',
                mobileOpen && 'rotate-180',
              )}
            />
          </button>
          {mobileOpen && (
            <nav id="settings-mobile-nav" aria-label="Settings navigation">
              <SettingsNav
                pathname={pathname}
                onNavigate={() => setMobileOpen(false)}
              />
            </nav>
          )}
        </div>

        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </Shell>
  );
}
