'use client';

import Link from 'next/link';
import { ArrowRight, Check, Loader2, Square } from 'lucide-react';
import { useProjectSetupState } from '@/features/project-setup/hooks/use-project-setup-state';
import type { ProjectSetupBooleans } from '@/features/project-setup/types';

interface ProjectOnboardingChecklistProps {
  slug: string;
  projectId?: string;
}

interface ChecklistItem {
  key: keyof ProjectSetupBooleans;
  label: string;
  href: string;
  cta: string;
}

export function ProjectOnboardingChecklist({
  slug,
  projectId,
}: ProjectOnboardingChecklistProps) {
  const setup = useProjectSetupState(projectId);

  const items: ChecklistItem[] = [
    {
      key: 'repo',
      label: 'Connect repository',
      href: `/projects/${slug}/settings?section=repo`,
      cta: 'Open settings',
    },
    {
      key: 'branches',
      label: 'Configure base / production branch',
      href: `/projects/${slug}/settings?section=basics`,
      cta: 'Open settings',
    },
    {
      key: 'members',
      label: 'Add members (optional)',
      href: `/projects/${slug}/settings?section=members`,
      cta: 'Open members',
    },
    {
      key: 'pipeline',
      label: 'Enable pipeline',
      href: `/projects/${slug}/settings?section=pipeline`,
      cta: 'Open pipeline',
    },
    {
      key: 'skills',
      label: 'Bind skills to stages',
      href: `/projects/${slug}/settings?section=skills`,
      cta: 'Open skills',
    },
    {
      key: 'devices',
      label: 'Assign at least 1 device',
      href: `/projects/${slug}/settings?section=devices`,
      cta: 'Open devices',
    },
    {
      key: 'firstIssue',
      label: 'Create first issue',
      href: `/projects/${slug}/issues/new`,
      cta: '+ New issue',
    },
    {
      key: 'firstRun',
      label: 'First successful pipeline run',
      href: `/projects/${slug}/pipeline`,
      cta: 'Open pipeline',
    },
  ];

  return (
    <section className="space-y-2">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-on-surface-variant">
        Get your project ready
      </h2>
      <ul className="divide-y divide-outline-variant/20 rounded-sm border border-outline-variant/20 bg-surface-container-low">
        {items.map((item) => {
          const done = setup[item.key];
          if (done === null) {
            return (
              <li key={item.key}>
                <div
                  data-testid={`checklist-loading-${item.key}`}
                  className="flex items-center gap-2 px-3 py-2 text-xs text-outline"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>{item.label}</span>
                </div>
              </li>
            );
          }
          if (done === true) {
            return (
              <li key={item.key}>
                <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                  <span className="flex items-center gap-2 text-on-surface-variant line-through decoration-outline/40">
                    <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                    {item.label}
                  </span>
                </div>
              </li>
            );
          }
          return (
            <li key={item.key}>
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
          );
        })}
      </ul>
    </section>
  );
}

export default ProjectOnboardingChecklist;
