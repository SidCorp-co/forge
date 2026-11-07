import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerProject } from '../db/read-memo.js';
import { requirementCriterionVerdicts } from '../db/schema-requirement-verdicts.js';
import { requirements } from '../db/schema-requirements.js';
import { type RequirementVerdictRead, verdictReadOf } from './standing-facts.js';

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
 * The verdicts recorded at the requirements `ids` of `projectId`, newest first
 * (`standing-facts.ts:requirementVerdictsOf`), read for the whole project once a read request, and
 * for every project asked with it in the same statement.
 */
export async function requirementVerdictsIn(
  projectId: string,
  ids: readonly string[],
): Promise<RequirementVerdictRead[]> {
  if (ids.length === 0) return [];
  // every project's asks before the quiet point are one read (ISS-1070 r6)
  const all = await rowsPerProject(
    'requirementVerdicts',
    projectId,
    verdictsInProjects,
    (v) => v.projectId,
  );
  const wanted = new Set(ids);
  return all.flatMap(({ projectId: _, ...v }) => (wanted.has(v.requirementId) ? [v] : []));
}
