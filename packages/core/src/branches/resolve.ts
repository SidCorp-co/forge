/**
 * Two-layer branch config resolver (PR-A foundation, ISS-135).
 *
 * Resolution order, per field:
 *   1. issue.metadata.branchConfig.<field>   (per-issue override)
 *   2. project.<field>                       (project default)
 *   3. 'main'                                (hard default)
 *
 * `targetBranch` has no dedicated project column today — it falls back to the
 * resolved `baseBranch` when no override sets it explicitly.
 *
 * Pure: no I/O, no DB, no framework imports. Safe to use from REST routes,
 * MCP tool handlers, and (eventually) web server components.
 */

export interface BranchConfig {
  baseBranch: string;
  targetBranch: string;
  prodBranch: string;
}

export interface IssueBranchOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
  prodBranch?: string | null;
}

export interface IssueLike {
  metadata?: { branchConfig?: IssueBranchOverride | null } | null;
}

export interface ProjectLike {
  baseBranch: string | null;
  productionBranch: string | null;
}

const HARD_DEFAULT = 'main';

function pick(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveIssueBranches(issue: IssueLike, project: ProjectLike): BranchConfig {
  const override = issue.metadata?.branchConfig ?? null;

  const baseBranch = pick(override?.baseBranch) ?? pick(project.baseBranch) ?? HARD_DEFAULT;
  const prodBranch =
    pick(override?.prodBranch) ?? pick(project.productionBranch) ?? HARD_DEFAULT;
  // No dedicated project column for target; default to the resolved base.
  const targetBranch = pick(override?.targetBranch) ?? baseBranch;

  return { baseBranch, targetBranch, prodBranch };
}
