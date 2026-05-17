'use client';

// Mirror of packages/core/src/branches/resolve.ts — keep in sync (PR-A, ISS-135).
// PR-A did not expose a REST endpoint for the resolved config; we read the
// project + issue from React Query state and resolve client-side so the aside
// card stays self-contained.

import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import type { Issue } from '@forge/contracts';

export interface BranchConfigResolved {
  baseBranch: string;
  targetBranch: string;
  prodBranch: string;
}

export interface BranchConfigOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
  prodBranch?: string | null;
}

const HARD_DEFAULT = 'main';

function pick(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function getIssueBranchOverride(issue: Issue): BranchConfigOverride | null {
  const meta = issue.metadata as { branchConfig?: BranchConfigOverride | null } | null | undefined;
  return meta?.branchConfig ?? null;
}

export function useResolvedBranchConfig(
  issue: Issue,
  projectSlug: string,
): BranchConfigResolved {
  const project = useProjectBySlug(projectSlug);
  const override = getIssueBranchOverride(issue);

  const baseBranch =
    pick(override?.baseBranch) ?? pick(project?.baseBranch ?? null) ?? HARD_DEFAULT;
  const prodBranch =
    pick(override?.prodBranch) ?? pick(project?.productionBranch ?? null) ?? HARD_DEFAULT;
  const targetBranch = pick(override?.targetBranch) ?? baseBranch;

  return { baseBranch, targetBranch, prodBranch };
}
