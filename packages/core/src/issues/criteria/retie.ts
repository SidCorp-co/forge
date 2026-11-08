// Re-tying the live issue criteria that trace one requirement criterion's wording to another, for a
// requirement criterion retired only for its title (requirements/revision-criteria.ts, D4).

import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { issueCriteria } from '../../db/schema-issue-criteria.js';

/**
 * Every live issue criterion tracing requirement criterion `from` traces `to` instead, inside the
 * caller's transaction. Retired issue criteria keep the wording they were judged on.
 */
export async function retieTracedCriteria(tx: Tx, from: string, to: string): Promise<void> {
  await tx
    .update(issueCriteria)
    .set({ requirementCriterionId: to })
    .where(and(eq(issueCriteria.requirementCriterionId, from), isNull(issueCriteria.retiredAt)));
}
