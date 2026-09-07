import { sql } from 'drizzle-orm';
import type { db } from '../db/client.js';

export type NameCheckExecutor = Pick<typeof db, 'select'>;

// cm:guard this must resolve to the TRANSACTION handle and never widen to `{ execute }` — `db` satisfies that shape, and `pg_advisory_xact_lock` on a pooled connection outside a transaction is released the instant the statement returns, so the call typechecks and locks nothing. `rollback()` is what `db` does not have, and it is the whole reason the alias is written this way (ISS-963)
export type NameLockTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type NameLockScope = 'issue' | 'comment';

/**
 * Serialise everyone racing for one name on one parent, for the length of one
 * transaction.
 *
 * The name rule is a read followed by a write with no constraint underneath, and
 * `getStorage().put` sits between them — so without this the check is decorative
 * for concurrent callers. Measured on 2026-09-07 at 6de2d969: four concurrent
 * `persistIssueAttachment` calls for one name stored four rows and refused none.
 *
 * A lock rather than a `UNIQUE (parent_id, name)` index because rows predating
 * the rule already violate it, and `CLAUDE.md` refuses to discard a row so an
 * `ALTER` can succeed. The key is the scope and the sanitised name, so it only
 * ever blocks the uploads that must be blocked.
 */
export async function lockAttachmentName(
  tx: NameLockTx,
  scope: NameLockScope,
  parentId: string,
  name: string,
): Promise<void> {
  // cm:guard `pg_advisory_xact_lock` and NOT the `_try_` form — a caller that cannot take the lock must WAIT for the holder and then see its row, because failing open is the bug this exists to close (ISS-963)
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${parentId}:${name}`}, 0))`,
  );
}
