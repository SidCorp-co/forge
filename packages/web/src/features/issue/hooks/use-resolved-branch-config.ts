'use client';

// Mirror of packages/core/src/branches/resolve.ts — keep in sync.
// No REST endpoint for resolved config; we read the project + issue from
// React Query state and resolve client-side so the aside card stays
// self-contained.

import { useProjectBySlug } from '@/features/project/hooks/use-projects';
import type { Issue } from '@forge/contracts';

export interface BranchConfigResolved {
  baseBranch: string | null;
  targetBranch: string | null;
  prodBranch: string | null;
}

export interface BranchConfigOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
  prodBranch?: string | null;
}

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

  const baseBranch = pick(override?.baseBranch) ?? pick(project?.baseBranch ?? null);
  const prodBranch = pick(override?.prodBranch) ?? pick(project?.productionBranch ?? null);
  const targetBranch = pick(override?.targetBranch) ?? baseBranch;

  return { baseBranch, targetBranch, prodBranch };
}
