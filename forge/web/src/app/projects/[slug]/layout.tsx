'use client';

import { useParams, usePathname } from 'next/navigation';
import { type ReactNode } from 'react';
import { Shell } from '@/components/layout/shell';
import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import { useSetPageTitle } from '@/hooks/use-page-title';
import { cn } from '@/lib/utils/cn';

export default function ProjectLayout({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const pathname = usePathname();
  const project = useProjectBySlug(slug);
  const base = `/projects/${slug}`;
  const isAgentPage = pathname === `${base}/agent`;
  useSetPageTitle(project?.name ?? '');

  return (
    <Shell>
      {!project ? (
        <p className="text-sm text-primary-fixed">Loading project...</p>
      ) : (
        <div
          className={cn(
            'flex flex-1 min-h-0 overflow-hidden gap-0',
            isAgentPage && 'bg-background',
          )}
        >
          <div
            className={cn(
              'flex-1 min-w-0 min-h-0 flex flex-col',
              isAgentPage
                ? 'overflow-hidden'
                : 'overflow-y-auto overflow-x-hidden px-2 py-3 sm:p-6',
            )}
          >
            {children}
          </div>
        </div>
      )}
    </Shell>
  );
}
