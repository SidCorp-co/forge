import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { comments, issues } from '../db/schema.js';

export type AuditComment = { id: string; body: string; parentId: string | null };

/**
 * ISS-286 — idempotent merge stamp. COALESCE keeps the FIRST timestamp, so a
 * repeated call is a no-op on the value and the audit trail records both
 * attempts. `at` overrides the server clock; null uses `now()`.
 */
// cm:why the explicit stamp binds as an ISO string with a `::timestamptz` cast — a bare `sql`${date}`` is an untyped parameter and Postgres cannot infer its type inside COALESCE("merged_at", $1), which was a live 500 on forge-beta for every mergedAt-supplied call
export async function stampIssueMergedAt(issueId: string, at: Date | null): Promise<void> {
  const stampExpr = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  await db
    .update(issues)
    .set({ mergedAt: sql`COALESCE(${issues.mergedAt}, ${stampExpr})`, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

/** Clearing `merged_at` re-blocks downstream children (ISS-286 AC4). */
export async function clearIssueMergedAt(issueId: string): Promise<void> {
  await db
    .update(issues)
    .set({ mergedAt: null, updatedAt: sql`now()` })
    .where(eq(issues.id, issueId));
}

// cm:guard ISS-820 — `isAi: true` is not cosmetic: a comment written by an automated surface and stored as human releases a `needs_info` bounce, so the issue leaves the state a human was asked to resolve
export async function writeAuditComment(
  issueId: string,
  authorId: string,
  body: string,
): Promise<AuditComment | null> {
  const [row] = await db
    .insert(comments)
    .values({ issueId, authorId, body, parentId: null, isAi: true })
    .returning({ id: comments.id, body: comments.body, parentId: comments.parentId });
  return row ?? null;
}
