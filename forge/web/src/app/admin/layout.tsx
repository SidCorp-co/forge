'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect } from 'react';
import { useAdminWhoami } from '@/features/admin/hooks/use-admin';

const TABS = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/projects', label: 'Projects' },
  { href: '/admin/devices', label: 'Devices' },
  { href: '/admin/audit', label: 'Audit log' },
];

export default function AdminLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { data, isLoading, isError } = useAdminWhoami();

  useEffect(() => {
    if (isLoading) return;
    if (isError || !data?.isAdmin) {
      router.replace('/');
    }
  }, [isLoading, isError, data?.isAdmin, router]);

  if (isLoading) {
    return (
      <div className="p-8 text-center text-xs font-mono text-outline-variant">
        LOADING ADMIN_SESSION…
      </div>
    );
  }

  if (isError || !data?.isAdmin) return null;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-outline-variant/30 bg-surface px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-sm font-bold uppercase tracking-[0.25em] text-primary">
            Admin
          </h1>
          <span className="text-[10px] uppercase tracking-widest text-outline">
            {data.email}
          </span>
        </div>
        <nav className="mt-4 flex gap-6 text-[11px] font-bold uppercase tracking-widest">
          {TABS.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={
                  active
                    ? 'text-primary'
                    : 'text-on-surface-variant transition-colors hover:text-on-surface'
                }
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="flex-1 px-6 py-6">{children}</main>
    </div>
  );
}
