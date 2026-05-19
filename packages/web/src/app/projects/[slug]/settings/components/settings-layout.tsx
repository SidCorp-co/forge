'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';

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

// Shorthand `?section=` aliases used by checklist + VerifyStep deep links.
// Keep in sync with section ids declared in settings/page.tsx.
const SECTION_ALIASES: Record<string, string> = {
  repo: 'identity.repo',
  basics: 'identity.basics',
  members: 'identity.members',
  devices: 'identity.devices',
  pipeline: 'pipeline.config',
  skills: 'pipeline.skills',
};

export function SettingsLayout({ groups, defaultSectionId }: SettingsLayoutProps) {
  const router = useRouter();
  const params = useSearchParams();
  const mainRef = useRef<HTMLElement | null>(null);

  const allSections = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const rawSection = params?.get('section') ?? null;
  const resolvedSection = rawSection ? (SECTION_ALIASES[rawSection] ?? rawSection) : null;
  const activeId =
    resolvedSection && allSections.some((s) => s.id === resolvedSection)
      ? resolvedSection
      : defaultSectionId;
  const active = allSections.find((s) => s.id === activeId) ?? allSections[0];

  useEffect(() => {
    if (rawSection) {
      mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

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

      <main ref={mainRef} className="min-w-0 space-y-12">{active?.render()}</main>
    </div>
  );
}
