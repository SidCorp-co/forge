'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { useProjectSetupState } from '@/features/project-setup/hooks/use-project-setup-state';

interface Props {
  slug: string;
  projectId: string | undefined;
}

export function ContinueSetupBanner({ slug, projectId }: Props) {
  const setup = useProjectSetupState(projectId);
  if (!projectId) return null;
  // Required-to-be-useful items: repo, pipeline, skills, devices. Members is
  // optional; firstIssue/firstRun are usage signals, not setup gaps.
  const hasGap =
    setup.repo === false ||
    setup.pipeline === false ||
    setup.skills === false ||
    setup.devices === false;
  if (!hasGap) return null;
  return (
    <Link
      href={`/projects/${slug}/setup`}
      className="flex items-center justify-between gap-3 rounded-sm border border-primary/30 bg-primary/5 px-4 py-2 text-xs hover:bg-primary/10"
    >
      <span className="text-on-surface">Continue project setup.</span>
      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-widest text-primary">
        Resume wizard
        <ArrowRight className="h-3 w-3" aria-hidden="true" />
      </span>
    </Link>
  );
}
