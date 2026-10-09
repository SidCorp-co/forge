// What a reporter's confirm on a fix preview is checked against once the fix ships (REQ-41 BC-20):
// the change that shipped, by the patch id the merge check recorded at the commit the issue merged
// (the fast lane's own test, `fast-lane/rules.ts:fastMergeRefusal`), and who the confirmer is.
// Reads only, of rows other modules write.

import { MERGE_CHECK_RECORD } from '@forge/contracts/merge-check';
import type { ActorAgency } from '@forge/contracts/permissions';
import { recordAction } from '@forge/contracts/record-events';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';

export interface ConfirmedIssue {
  issueId: string;
  /** The commit the issue merged; null until it did. */
  mergedSha: string | null;
}

/** The issue whose preview a confirm was made on, and the commit it merged. */
export async function issueOfPreview(previewId: string): Promise<ConfirmedIssue | null> {
  const rows = (await db.execute(sql`
    SELECT i.id, i.merged_commit_sha FROM previews p JOIN issues i ON i.id = p.issue_id
     WHERE p.id = ${previewId}::uuid
  `)) as unknown as { id: string; merged_commit_sha: string | null }[];
  const row = rows[0];
  return row ? { issueId: row.id, mergedSha: row.merged_commit_sha?.toLowerCase() ?? null } : null;
}

type Field = { key?: unknown; value?: unknown };

/**
 * The patch id of what an issue shipped: the `patch-id` of the passing merge check recorded by core
 * at the commit it merged (`issues/merge-check-rules.ts:recordFields`). Null where it merged no
 * commit, or no merge check at that commit carries a patch id (a record written before every report
 * carried one), so nothing tells that what shipped is what a person saw. Either lane's check counts.
 */
export async function shippedPatchOf(issue: ConfirmedIssue): Promise<string | null> {
  const merged = issue.mergedSha;
  if (!merged) return null;
  const rows = (await db.execute(sql`
    SELECT payload -> 'fields' AS fields FROM activity_log
     WHERE issue_id = ${issue.issueId}::uuid AND action = ${recordAction('verification')}
       AND payload ->> 'writer' = 'core'
     ORDER BY created_at DESC, id DESC
  `)) as unknown as { fields: unknown }[];
  for (const { fields } of rows) {
    if (!Array.isArray(fields)) continue;
    const field = (key: string) => {
      const f = (fields as Field[]).find((x) => x?.key === key)?.value;
      return typeof f === 'string' ? f : null;
    };
    if (field('check') !== MERGE_CHECK_RECORD || field('result') !== 'pass') continue;
    const head = field('head')?.toLowerCase();
    // a mark takes 7 to 64 hex, so either side may be the shorter
    if (!head || !(head.startsWith(merged) || merged.startsWith(head))) continue;
    const patch = field('patch-id');
    if (patch) return patch;
  }
  return null;
}

/** Whether the confirmer is an agent account, so their decision says so as a person's would. */
export async function agencyOf(userId: string): Promise<ActorAgency> {
  const rows = (await db.execute(
    sql`SELECT kind FROM users WHERE id = ${userId}::uuid`,
  )) as unknown as { kind: string }[];
  return rows[0]?.kind === 'agent' ? 'agent' : 'human';
}
