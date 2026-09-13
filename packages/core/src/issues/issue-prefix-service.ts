import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issuePrefixAliases, projects } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type IssuePrefixShapeError, validateIssuePrefix } from '../lib/issue-ref.js';
import { issuePrefixHolder } from './issue-prefix-read.js';

export type AssignPrefixResult =
  | { ok: true; prefix: string }
  | IssuePrefixShapeError
  | { ok: false; reason: 'taken'; holderProjectId: string | null };

/** Give a project a prefix, or move it back to one it already holds. */
// cm:guard the alias row and `projects.issue_prefix` are written in ONE transaction, and the pointer moves on EVERY accepted assignment — returning success for an alias this project already owns without moving the pointer acknowledges a change it did not apply, and the project goes on rendering its old prefix (ISS-992)
// cm:edge lockstep -> packages/core/src/db/schema.ts#issuePrefixAliases — `projects_issue_prefix_fk` is what makes a divergence between the two unrepresentable rather than merely unlikely
export async function assignIssuePrefix(
  projectId: string,
  raw: string,
): Promise<AssignPrefixResult> {
  const shape = validateIssuePrefix(raw);
  if (!shape.ok) return shape;
  const prefix = shape.prefix;

  try {
    return await db.transaction(async (tx) => {
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
      await tx.update(projects).set({ issuePrefix: prefix }).where(eq(projects.id, projectId));
      return { ok: true as const, prefix };
    });
  } catch (err) {
    // cm:guard the losing side of two callers claiming one free prefix at once: both reads found it free, the index refused the second insert, and without this the caller gets a 500 on what is an ordinary conflict. Re-reading names the winner rather than guessing it.
    if (!isUniqueViolation(err)) throw err;
    const holder = await issuePrefixHolder(prefix);
    return { ok: false, reason: 'taken', holderProjectId: holder?.projectId ?? null };
  }
}

/** Send a project back to the legacy `ISS`. The alias it held is NOT released — see the guard on
 *  `issuePrefixAliases`. */
export async function retireIssuePrefix(projectId: string): Promise<void> {
  await db.update(projects).set({ issuePrefix: null }).where(eq(projects.id, projectId));
}
