'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';

export interface SettingsSection {
  id: string;
  label: string;
  tag: string;
  render: () => ReactNode;
}

export interface SettingsGroup {
  label: string;
  items: SettingsSection[];
}

interface SettingsLayoutProps {
  groups: SettingsGroup[];
  defaultSectionId: string;
}

export function SettingsLayout({ groups, defaultSectionId }: SettingsLayoutProps) {
  const router = useRouter();
  const params = useSearchParams();

  const allSections = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const sectionParam = params?.get('section');
  const activeId =
    sectionParam && allSections.some((s) => s.id === sectionParam)
      ? sectionParam
      : defaultSectionId;
  const active = allSections.find((s) => s.id === activeId) ?? allSections[0];

  const selectSection = (id: string) => {
    const next = new URLSearchParams(params?.toString() ?? '');
    next.set('section', id);
    router.replace(`?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-8">
      <nav aria-label="Settings sections" className="space-y-6">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="mb-2 text-[9px] uppercase tracking-[0.2em] text-outline font-bold">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = item.id === activeId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => selectSection(item.id)}
                      className={`flex w-full items-center justify-between border-l-2 px-3 py-1.5 text-left text-[11px] uppercase tracking-[0.12em] font-medium transition-colors ${
                        isActive
                          ? 'border-primary text-primary'
                          : 'border-transparent text-on-surface-variant hover:border-outline/40 hover:text-on-surface'
                      }`}
                    >
                      <span>{item.label}</span>
                      <span className="ml-2 text-[9px] font-mono text-outline">{item.tag}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <main className="min-w-0 space-y-12">{active?.render()}</main>
    </div>
  );
}
