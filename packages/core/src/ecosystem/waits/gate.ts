import { CONTRACT_WAIT_UNSETTLED } from '@forge/contracts/contract-waits';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { activeIssuePrefix } from '../../issues/issue-prefix-read.js';
import { formatIssueRef } from '../../lib/issue-ref.js';
import { holdsDispatch, unsettledDetail } from './rules.js';

export function waitUnsettledSql(issueId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM issue_contract_waits cw
    WHERE cw.issue_id = ${issueId}
      AND cw.retracted_at IS NULL
      AND cw.settled_at IS NULL
  )`;
}

export interface UnsettledWait {
  issue: string;
  contract: string;
  minVersion: string;
  current: string | null;
}

export class ContractWaitUnsettledError extends Error {
  readonly code = CONTRACT_WAIT_UNSETTLED;
  constructor(readonly blocked: UnsettledWait[]) {
    super(`${CONTRACT_WAIT_UNSETTLED}: ${blocked.map(unsettledDetail).join(' ')}`);
    this.name = 'ContractWaitUnsettledError';
  }
}

async function heldWhere(projectId: string, filter: SQL): Promise<UnsettledWait[]> {
  const rows = (await db.execute(sql`
    SELECT i.iss_seq, p.slug AS provider_slug, cw.contract_slug, cw.min_version,
           cw.retracted_at, cw.settled_at,
           (SELECT v.version FROM contract_versions v
             WHERE v.provider_project_id = cw.provider_project_id
               AND v.contract_slug = cw.contract_slug AND v.approval = 'approved'
             ORDER BY v.recorded_at DESC LIMIT 1) AS current
    FROM issue_contract_waits cw
    JOIN issues i ON i.id = cw.issue_id
    JOIN projects p ON p.id = cw.provider_project_id
    WHERE cw.project_id = ${projectId}
      AND ${filter}
    ORDER BY i.iss_seq, cw.created_at
  `)) as unknown as Array<Record<string, unknown>>;
  const prefix = rows.length > 0 ? await activeIssuePrefix(projectId) : null;
  return rows
    .filter((r) =>
      holdsDispatch({
        retractedAt: r.retracted_at ? new Date(String(r.retracted_at)) : null,
        settledAt: r.settled_at ? new Date(String(r.settled_at)) : null,
      }),
    )
    .map((r) => ({
      issue: formatIssueRef(prefix, Number(r.iss_seq)),
      contract: `${String(r.provider_slug)}/${String(r.contract_slug)}`,
      minVersion: String(r.min_version),
      current: (r.current as string | null) ?? null,
    }));
}

function refuseHeld(held: UnsettledWait[]): void {
  if (held.length > 0) throw new ContractWaitUnsettledError(held);
}

export async function assertWaitsSettledForSeqs(
  projectId: string,
  seqs: readonly number[],
): Promise<void> {
  if (seqs.length === 0) return;
  const list = sql.join(
    seqs.map((n) => sql`${n}`),
    sql`, `,
  );
  refuseHeld(await heldWhere(projectId, sql`i.iss_seq IN (${list})`));
}

export async function assertWaitsSettledForIssue(
  projectId: string,
  issueId: string,
): Promise<void> {
  refuseHeld(await heldWhere(projectId, sql`i.id = ${issueId}`));
}
