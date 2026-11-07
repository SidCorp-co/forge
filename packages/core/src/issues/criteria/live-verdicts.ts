// Every verdict on an issue's live criteria with who recorded it, as the verified rule reads them
// (contracts `verified-rule.ts`): the history a criterion's standing verdict is chosen from.

import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import {
  builderFactColumnsSql,
  builderFactJoinSql,
  readWithBuilderFacts,
} from '../builder-facts.js';
import { type LatestVerdict, type ListRow, latestOf } from './store.js';

/** A verdict with who recorded it, as the verified rule reads it (contracts `verified-rule.ts`). */
export interface AuthoredVerdict extends LatestVerdict {
  /** Recorded by the issue's builder (`issues/built-by.ts`). */
  readonly byBuilder: boolean;
  /** Names who recorded it, an account or a box. */
  readonly authored: boolean;
  /** When it was recorded (`createdAt`), as the verified rule reads it. */
  readonly recordedAt: string;
}

/**
 * Every verdict on each issue's live criteria, newest first, by criterion number, each with who
 * recorded it, in one statement however many issues: what the criteria hold reads the verdict a
 * criterion stands on from (contracts `verified-rule.ts:judgesVerdict`). An issue with none maps to
 * an empty map.
 */
export async function liveVerdictsOfIssues(
  executor: Pick<Tx, 'execute'>,
  issueIds: readonly string[],
): Promise<Map<string, Map<number, AuthoredVerdict[]>>> {
  const out = new Map<string, Map<number, AuthoredVerdict[]>>(
    issueIds.map((id) => [id, new Map()]),
  );
  if (issueIds.length === 0) return out;
  const issueList = sql.join(
    issueIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  // the builder rule is read from the model each write keeps (`builder-facts.ts`), never computed here
  const rows = await readWithBuilderFacts(
    executor,
    async () =>
      (await executor.execute(sql`
    SELECT c.issue_id::text AS issue_id, c.n, v.id AS v_id, v.verdict, v.reason, v.identity_kind,
           v.commit_sha, v.runtime_ref,
           v.design_workflow_id, w.flow AS design_flow, v.design_revision, v.contract_ref,
           v.contract_version, v.release_version, v.storefront_drafts,
           v.storefront_environment, v.corroboration, v.corroboration_note, v.evidence, v.covers, v.probe_id,
           v.author_agency, v.backfilled, v.created_at AS v_created_at,
           ${builderFactColumnsSql(sql`c.issue_id`)},
           (v.author_user_id IS NOT NULL OR v.author_device_id IS NOT NULL) AS authored
      FROM issue_criteria c
      JOIN criterion_verdicts v ON v.criterion_id = c.id
      ${builderFactJoinSql(sql`v.id`)}
      LEFT JOIN project_workflows w ON w.id = v.design_workflow_id
     WHERE c.issue_id IN (${issueList}) AND c.retired_at IS NULL
     ORDER BY c.issue_id, c.n, v.created_at DESC, v.id DESC`)) as unknown as (ListRow & {
        issue_id: string;
        by_builder: boolean | null;
        authored: boolean | null;
        fact_owed: boolean;
        fact_missing: boolean;
      })[],
    (r) => (r.fact_owed ? { issueId: r.issue_id, missing: r.fact_missing } : null),
  );
  for (const row of rows) {
    const verdict = latestOf(row);
    const issue = out.get(row.issue_id);
    if (!verdict || !issue) continue;
    const list = issue.get(row.n) ?? [];
    list.push({
      ...verdict,
      byBuilder: row.by_builder === true,
      authored: row.authored === true,
      recordedAt: verdict.createdAt,
    });
    issue.set(row.n, list);
  }
  return out;
}
