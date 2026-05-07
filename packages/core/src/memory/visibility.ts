import type { MemoryRole, MemoryVisibility } from '../db/schema.js';

// Lower rank = higher seniority. The exact ordering matters for `up`/`down`
// visibility resolution, so it is asserted by visibility.test.ts.
export const ROLE_RANK: Record<MemoryRole, number> = {
  ceo: 0,
  cto: 1,
  po: 2,
  techlead: 3,
  pm: 4,
  dev: 5,
  qa: 6,
  devops: 7,
};

// Per-skill default scope: which memory roles a skill is allowed to read
// when no explicit `allowedRoles` is passed. Kept deliberately small —
// callers typically pass `allowedRoles` directly.
export const SKILL_MEMORY_ROLES: Record<string, MemoryRole[]> = {
  'forge-plan': ['ceo', 'cto', 'techlead'],
  'forge-triage': ['ceo', 'cto', 'pm', 'po', 'techlead'],
  'forge-code': ['ceo', 'cto', 'po', 'techlead', 'pm', 'dev'],
  'forge-review': ['ceo', 'cto', 'techlead', 'dev'],
  'forge-clarify': ['ceo', 'cto', 'pm', 'po', 'techlead', 'dev', 'qa', 'devops'],
};

function knownRoles(viewerRoles: readonly string[]): MemoryRole[] {
  return viewerRoles.filter((r): r is MemoryRole => r in ROLE_RANK);
}

/**
 * Resolve whether a memory tagged `(memoryRole, visibility)` is visible to a
 * viewer who holds `viewerRoles`. Unknown viewer roles are silently dropped;
 * if no viewer role is recognised, the memory is hidden (safe default).
 */
export function isVisibleTo(
  memoryRole: MemoryRole,
  visibility: MemoryVisibility,
  viewerRoles: readonly string[],
): boolean {
  if (visibility === 'all') return true;
  const known = knownRoles(viewerRoles);
  if (known.length === 0) return false;
  const memoryRank = ROLE_RANK[memoryRole];
  switch (visibility) {
    case 'same':
      return known.some((r) => r === memoryRole);
    case 'down':
      return known.some((r) => ROLE_RANK[r] > memoryRank);
    case 'up':
      return known.some((r) => ROLE_RANK[r] < memoryRank);
    default:
      return false;
  }
}

/**
 * Precompute the set of `(role, visibility)` pairs the viewer can see, for
 * pushdown into a SQL `(role, visibility) IN (...)` filter. Returning an
 * empty array means "viewer sees nothing" — callers must short-circuit.
 */
export function allowedRoleVisibilityPairs(
  viewerRoles: readonly MemoryRole[],
): Array<{ role: MemoryRole; visibility: MemoryVisibility }> {
  const pairs: Array<{ role: MemoryRole; visibility: MemoryVisibility }> = [];
  const visibilities: MemoryVisibility[] = ['all', 'same', 'down', 'up'];
  for (const role of Object.keys(ROLE_RANK) as MemoryRole[]) {
    for (const visibility of visibilities) {
      if (isVisibleTo(role, visibility, viewerRoles)) {
        pairs.push({ role, visibility });
      }
    }
  }
  return pairs;
}
