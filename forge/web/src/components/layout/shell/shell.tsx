'use client';

import { useState, useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';
import { SidebarNav } from './sidebar-nav';
import { TopBar } from './top-bar';
import { useIosViewport } from './hooks/use-ios-viewport';

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const shellRef = useIosViewport();

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div ref={shellRef} className="fixed inset-0 flex bg-background">
      {/* Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-on-primary/50 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex flex-col border-r border-outline-variant/30 bg-surface transition-all duration-200',
          collapsed ? 'w-0 overflow-hidden md:w-0' : 'w-64',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        <SidebarNav onClose={() => setMobileOpen(false)} />
      </aside>

      {/* Collapse toggle — desktop only */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className={cn(
          'fixed top-3 z-50 hidden h-7 w-7 items-center justify-center rounded-sm border border-outline-variant bg-surface-container-low text-outline shadow-sm hover:text-on-surface hover:border-outline transition-all duration-200 md:flex',
          collapsed ? 'left-2' : 'left-[15rem]'
        )}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          {collapsed
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          }
        </svg>
      </button>

      <main className={cn(
        'relative min-w-0 flex-1 flex flex-col overflow-hidden overflow-x-hidden transition-[margin] duration-200',
        collapsed ? 'md:ml-0' : 'md:ml-64'
      )}>
        <TopBar onMenuOpen={() => setMobileOpen(true)} />
        {children}
      </main>
    </div>
  );
}
