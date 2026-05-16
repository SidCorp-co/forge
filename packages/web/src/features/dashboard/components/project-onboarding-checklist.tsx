'use client';

import Link from 'next/link';
import { Square, ArrowRight } from 'lucide-react';

interface ProjectOnboardingChecklistProps {
  slug: string;
}

interface ChecklistItem {
  label: string;
  href: string;
  cta: string;
}

export function ProjectOnboardingChecklist({ slug }: ProjectOnboardingChecklistProps) {
  const items: ChecklistItem[] = [
    {
      label: 'Connect repository',
      href: `/projects/${slug}/settings?section=repo`,
      cta: 'Open settings',
    },
    {
      label: 'Configure base / production branch',
      href: `/projects/${slug}/settings?section=basics`,
      cta: 'Open settings',
    },
    {
      label: 'Create your first issue',
      href: `/projects/${slug}/issues/new`,
      cta: '+ New issue',
    },
    {
      label: 'Invite teammates',
      href: `/projects/${slug}/settings?section=members`,
      cta: 'Open members',
    },
  ];

  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
        Get your project ready
      </h2>
      <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-surface-container-high"
            >
              <span className="flex items-center gap-2 text-on-surface">
                <Square className="h-3.5 w-3.5 text-outline" aria-hidden="true" />
                {item.label}
              </span>
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-primary hover:underline">
                {item.cta}
                <ArrowRight className="h-3 w-3" aria-hidden="true" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ProjectOnboardingChecklist;
