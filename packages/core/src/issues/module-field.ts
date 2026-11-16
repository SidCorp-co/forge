// An issue's module (ISS-1256): the field is its primary module label (`issue_labels.is_primary`,
// ISS-593), set here by the module map's placement door: the old primary is detached, the other
// labels stay as they are.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels } from '../db/schema.js';

/** Make `moduleId` the issue's primary module, or clear it (`null`); the primary it had before. */
export async function setIssuePrimaryModule(
  issueId: string,
  moduleId: string | null,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ labelId: issueLabels.labelId })
      .from(issueLabels)
      .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.isPrimary, true)));
    if (before) {
      await tx
        .delete(issueLabels)
        .where(and(eq(issueLabels.issueId, issueId), eq(issueLabels.labelId, before.labelId)));
    }
    if (moduleId) {
      await tx
        .insert(issueLabels)
        .values({ issueId, labelId: moduleId, isPrimary: true })
        .onConflictDoUpdate({
          target: [issueLabels.issueId, issueLabels.labelId],
          set: { isPrimary: true },
        });
    }
    return before?.labelId ?? null;
  });
}
