import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issuePrefixAliases, projects } from '../db/schema.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { type IssuePrefixShapeError, validateIssuePrefix } from '../lib/issue-ref.js';
import { issuePrefixHolder } from './issue-prefix-read.js';

export type PrefixWriter = Pick<typeof db, 'transaction' | 'select' | 'insert' | 'update'>;

export type AssignPrefixResult =
  | { ok: true; prefix: string }
  | IssuePrefixShapeError
  | { ok: false; reason: 'taken'; holderProjectId: string | null };

/** Give a project a prefix, or move it back to one it already holds. */
export async function assignIssuePrefix(
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
      await tx.update(projects).set({ issuePrefix: prefix }).where(eq(projects.id, projectId));
      return { ok: true as const, prefix };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const holder = await issuePrefixHolder(prefix);
    if (holder?.projectId === projectId) {
      await dbi.update(projects).set({ issuePrefix: prefix }).where(eq(projects.id, projectId));
      return { ok: true, prefix };
    }
    return { ok: false, reason: 'taken', holderProjectId: holder?.projectId ?? null };
  }
}

/** Send a project back to the legacy `ISS`. The alias it held is NOT released — see the guard on
 *  `issuePrefixAliases`. */
export async function retireIssuePrefix(projectId: string, dbi: PrefixWriter = db): Promise<void> {
  await dbi.update(projects).set({ issuePrefix: null }).where(eq(projects.id, projectId));
}
