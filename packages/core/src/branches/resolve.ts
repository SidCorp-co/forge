export interface BranchConfig {
  baseBranch: string | null;
  targetBranch: string | null;
}

export interface IssueBranchOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
}

export interface IssueLike {
  metadata?: ({ branchConfig?: IssueBranchOverride | null } & Record<string, unknown>) | null;
}

export interface ProjectLike {
  baseBranch: string | null;
}

function pick(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveIssueBranches(issue: IssueLike, project: ProjectLike): BranchConfig {
  const override = issue.metadata?.branchConfig ?? null;

  const baseBranch = pick(override?.baseBranch) ?? pick(project.baseBranch);
  const targetBranch = pick(override?.targetBranch) ?? baseBranch;

  return { baseBranch, targetBranch };
}

export function extractIssueBranchOverride(issue: {
  metadata?: { branchConfig?: IssueBranchOverride | null } | null;
  sessionContext?: { branchConfig?: IssueBranchOverride | null } | null;
}): IssueBranchOverride | null {
  return issue.metadata?.branchConfig ?? issue.sessionContext?.branchConfig ?? null;
}
