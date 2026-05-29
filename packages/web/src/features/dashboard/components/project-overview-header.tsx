'use client';

import Link from 'next/link';
import { GitBranch } from 'lucide-react';
import type { Project } from '@forge/contracts';
import { Button } from '@/components/ui/button';

interface ProjectOverviewHeaderProps {
  project: Project;
  slug: string;
  // Branch/repo fields come from the project DETAIL endpoint (GET /projects/:id),
  // not the list (GET /projects) that `project` is derived from — the list
  // projection omits them, so they must be passed in explicitly. Nullable +
  // undefined while the detail query is in flight.
  baseBranch?: string | null;
  productionBranch?: string | null;
  repoPath?: string | null;
}

function BranchPill({ label, branch }: { label: string; branch: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-sm border border-outline-variant/30 bg-surface-container-low px-2 py-0.5 font-mono text-[10px] text-on-surface-variant">
      <GitBranch className="h-3 w-3 text-outline" />
      <span className="text-outline">{label}</span>
      <span className="text-on-surface">{branch}</span>
    </span>
  );
}

export function ProjectOverviewHeader({
  project,
  slug,
  baseBranch,
  productionBranch,
  repoPath,
}: ProjectOverviewHeaderProps) {
  return (
    <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h1 className="truncate text-xl font-semibold text-on-surface">{project.name}</h1>
          <span className="font-mono text-xs text-on-surface-variant">/{slug}</span>
        </div>
        {(baseBranch || productionBranch || repoPath) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {baseBranch && <BranchPill label="base" branch={baseBranch} />}
            {productionBranch && <BranchPill label="prod" branch={productionBranch} />}
            {repoPath && (
              <span className="max-w-[16rem] truncate font-mono text-[10px] text-outline" title={repoPath}>
                {repoPath}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Link href={`/projects/${slug}/issues`}>
          <Button variant="ghost" size="xs">
            Issues
          </Button>
        </Link>
        <Link href={`/projects/${slug}/settings`}>
          <Button variant="ghost" size="xs">
            Settings
          </Button>
        </Link>
        <Link href={`/projects/${slug}/issues/new`}>
          <Button size="xs">New Issue</Button>
        </Link>
      </div>
    </header>
  );
}

export default ProjectOverviewHeader;
