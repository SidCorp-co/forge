import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issuePrefixAliases } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { validateIssuePrefix } from '../lib/issue-ref.js';
import type { AssignPrefixResult, PrefixWriter } from '../projects/index.js';
import { issuePrefixHolder } from './issue-prefix-read.js';

/** Hold a prefix for a project, or find it already held by that project. The projects domain writes
 *  the project's active prefix once this answers ok. */
export async function claimIssuePrefix(
  projectId: string,
  raw: string,
  dbi: PrefixWriter = db,
): Promise<AssignPrefixResult> {
  const shape = validateIssuePrefix(raw);
  if (!shape.ok) return shape;
  const prefix = shape.prefix;

  try {
    return await dbi.transaction(async (tx) => {
      const [held] = await tx
        .select({ projectId: issuePrefixAliases.projectId })
        .from(issuePrefixAliases)
        .where(eq(issuePrefixAliases.prefix, prefix))
        .limit(1);

      if (held && held.projectId !== projectId) {
        return { ok: false as const, reason: 'taken' as const, holderProjectId: held.projectId };
      }
      if (!held) {
        await tx.insert(issuePrefixAliases).values({ projectId, prefix });
      }
      return { ok: true as const, prefix };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const holder = await issuePrefixHolder(prefix);
    if (holder?.projectId === projectId) return { ok: true, prefix };
    return { ok: false, reason: 'taken', holderProjectId: holder?.projectId ?? null };
  }
}
