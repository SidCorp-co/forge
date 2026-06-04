/**
 * Two-layer branch config resolver.
 *
 * Resolution order, per field:
 *   1. issue.metadata.branchConfig.<field>   (per-issue override)
 *   2. project.<field>                       (project default — column on `projects`)
 *
 * No hard 'main' fallback — if both layers are unset, the field is `null` so
 * callers surface the misconfig instead of silently merging to main.
 * `targetBranch` has no dedicated project column; falls back to the resolved
 * `baseBranch` when no override sets it explicitly (so `targetBranch` is null
 * only when `baseBranch` is also null).
 *
 * Pure: no I/O, no DB, no framework imports. Safe to use from REST routes,
 * MCP tool handlers, and (eventually) web server components.
 */

export interface BranchConfig {
  baseBranch: string | null;
  targetBranch: string | null;
  prodBranch: string | null;
}

export interface IssueBranchOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
  prodBranch?: string | null;
}

export interface IssueLike {
  metadata?:
    | ({ branchConfig?: IssueBranchOverride | null; useIntegrationBranch?: boolean } & Record<
        string,
        unknown
      >)
    | null;
}

export interface ProjectLike {
  baseBranch: string | null;
  productionBranch: string | null;
}

function pick(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveIssueBranches(issue: IssueLike, project: ProjectLike): BranchConfig {
  const override = issue.metadata?.branchConfig ?? null;

  const baseBranch = pick(override?.baseBranch) ?? pick(project.baseBranch);
  const prodBranch = pick(override?.prodBranch) ?? pick(project.productionBranch);
  const targetBranch = pick(override?.targetBranch) ?? baseBranch;

  return { baseBranch, targetBranch, prodBranch };
}

/**
 * Pull a per-issue branch override off an issue row. The override lives on
 * `metadata.branchConfig` once the real column lands (ISS PR-C); until then it
 * falls back to `sessionContext.branchConfig`. Pure — pass the result as
 * `{ metadata: { branchConfig } }` into {@link resolveIssueBranches}.
 */
export function extractIssueBranchOverride(issue: {
  metadata?: { branchConfig?: IssueBranchOverride | null } | null;
  sessionContext?: { branchConfig?: IssueBranchOverride | null } | null;
}): IssueBranchOverride | null {
  return issue.metadata?.branchConfig ?? issue.sessionContext?.branchConfig ?? null;
}
