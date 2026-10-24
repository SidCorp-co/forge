import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { memoizedRead, primeReads } from '../db/read-memo.js';
import { requirementCriterionVerdicts } from '../db/schema-requirement-verdicts.js';
import { requirements } from '../db/schema-requirements.js';
import { type RequirementVerdictRead, verdictReadOf } from './standing-facts.js';

const verdictsInKey = (projectId: string) => `requirementVerdicts:${projectId}`;

/** Every verdict recorded at a requirement of the projects `projectIds`, newest first, in one statement. */
async function verdictsInProjects(projectIds: readonly string[]) {
  const rows = await db
    .select({ projectId: requirements.projectId, verdict: requirementCriterionVerdicts })
    .from(requirementCriterionVerdicts)
    .innerJoin(requirements, eq(requirements.id, requirementCriterionVerdicts.requirementId))
    .where(inArray(requirements.projectId, [...projectIds]))
    .orderBy(desc(requirementCriterionVerdicts.createdAt));
  return rows.map((r) => ({ projectId: r.projectId, ...verdictReadOf(r.verdict) }));
}

/**
 * The requirement verdicts of every project in `projectIds` in one statement, so the Needs-you read
 * across projects reads them for no statement more a project (`db/read-memo.ts:primeReads`).
 */
export function primeRequirementVerdicts(projectIds: readonly string[]): void {
  primeReads(projectIds, verdictsInKey, verdictsInProjects, (r) => r.projectId);
}

/**
 * The verdicts recorded at the requirements `ids` of `projectId`, newest first
 * (`standing-facts.ts:requirementVerdictsOf`), read for the whole project once a read request.
 */
export async function requirementVerdictsIn(
  projectId: string,
  ids: readonly string[],
): Promise<RequirementVerdictRead[]> {
  if (ids.length === 0) return [];
  const all = await memoizedRead(verdictsInKey(projectId), () => verdictsInProjects([projectId]));
  const wanted = new Set(ids);
  return all.flatMap(({ projectId: _, ...v }) => (wanted.has(v.requirementId) ? [v] : []));
}
