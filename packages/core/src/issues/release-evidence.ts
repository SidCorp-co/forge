// ISS-55 — the move history a verdict is read against: a verdict at or before an issue's latest
// reopen is not current evidence, and a release that shipped an issue it later withdrew holds nothing.

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';

/**
 * When each issue last entered `reopen`, read from the move history (`kernel_transitions`); an
 * issue never reopened is absent. A verdict at or before that instant is not current evidence:
 * the release hold and every coverage reader read it as not judged.
 */
export async function reopenedAtOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, Date>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT entity_id, max(created_at) AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'reopen'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     GROUP BY entity_id`)) as unknown as Array<{ entity_id: string; at: Date | string }>;
  return new Map([...rows].map((r) => [r.entity_id, new Date(r.at)]));
}

/**
 * Every move of each issue into `closed`, oldest first, from the move history (`kernel_transitions`);
 * an issue never closed is absent. Only a release closes an issue (`CLOSE_ONLY_BY_RELEASE`), so each
 * is the moment some release shipped it: the release page reads its own among them.
 */
export async function closedAtOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, Date[]>> {
  if (issueIds.length === 0) return new Map();
  const rows = (await executor.execute(sql`
    SELECT entity_id::text AS issue_id, created_at AS at
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND to_status = 'closed'
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY created_at ASC`)) as unknown as Array<{ issue_id: string; at: Date | string }>;
  const out = new Map<string, Date[]>();
  for (const r of rows) out.set(r.issue_id, [...(out.get(r.issue_id) ?? []), new Date(r.at)]);
  return out;
}

/**
 * The issues whose ship was withdrawn: the newest move touching `closed` (`kernel_transitions`)
 * took the issue out of it. A release that closed such an issue shipped work its reopen rejected,
 * so no reader takes that release as where the issue's work is until a release closes it again.
 * The release's own roster record is untouched: it still names what that release shipped.
 */
export async function shipsWithdrawnOf(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();
  const rows = (await executor.execute(sql`
    SELECT DISTINCT ON (entity_id) entity_id::text AS issue_id, from_status = 'closed' AS withdrawn
      FROM kernel_transitions
     WHERE entity = 'issue'
       AND (to_status = 'closed' OR from_status = 'closed')
       AND entity_id IN (${sql.join(
         issueIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
     ORDER BY entity_id, created_at DESC, (from_status = 'closed') DESC`)) as unknown as Array<{
    issue_id: string;
    withdrawn: boolean;
  }>;
  return new Set([...rows].filter((r) => r.withdrawn).map((r) => r.issue_id));
}
