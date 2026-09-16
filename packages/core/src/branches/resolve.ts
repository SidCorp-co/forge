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
  /**
   * Where a `promote` release lands. It carries NO claim that this project promotes: 25 of 32 fleet
   * projects hold a value here from the era when the column had a `'main'` default, six of them a
   * branch genuinely distinct from their base. `releaseModel` is what says whether it means anything.
   */
  liveBranch: string | null;
}

export interface IssueBranchOverride {
  baseBranch?: string | null;
  targetBranch?: string | null;
  liveBranch?: string | null;
}

export interface IssueLike {
  metadata?: ({ branchConfig?: IssueBranchOverride | null } & Record<string, unknown>) | null;
}

export interface ProjectLike {
  baseBranch: string | null;
  liveBranch: string | null;
}

function pick(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveIssueBranches(issue: IssueLike, project: ProjectLike): BranchConfig {
  const override = issue.metadata?.branchConfig ?? null;

  const baseBranch = pick(override?.baseBranch) ?? pick(project.baseBranch);
  const liveBranch = pick(override?.liveBranch) ?? pick(project.liveBranch);
  const targetBranch = pick(override?.targetBranch) ?? baseBranch;

  return { baseBranch, targetBranch, liveBranch };
}

/**
 * Pull a per-issue branch override off an issue row. `metadata.branchConfig`
 * wins; `sessionContext.branchConfig` is the older location and the fallback.
 * Pure — pass the result as `{ metadata: { branchConfig } }` into
 * {@link resolveIssueBranches}.
 */
export function extractIssueBranchOverride(issue: {
  metadata?: { branchConfig?: IssueBranchOverride | null } | null;
  sessionContext?: { branchConfig?: IssueBranchOverride | null } | null;
}): IssueBranchOverride | null {
  return issue.metadata?.branchConfig ?? issue.sessionContext?.branchConfig ?? null;
}
