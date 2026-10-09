/**
 * Two issues whose declared scope meets are never worked by two live runs at once (REQ-36 BC-5).
 *
 * The scope is the design record's modules and contracts (`design-record.ts`); held is a lease of a
 * run that has not ended (`issue-lease.ts`). The predicate is `db/schema-issue-designs.ts:
 * scopeHoldersSql`, which the admissible list and the strand sweep also read, so a door that
 * refuses and a list that withholds name one rule. This module turns its rows into the refusal: the
 * issue, what it shares, the holding issue and its run, and that the hold lifts when that run ends.
 *
 * Asked at three doors: the run-session preflight and open (`blocked-by.ts:refuseHeldTakeForSeqs`),
 * the lease take inside the open's transaction (`issue-lease.ts:takeIssueLeases`), and the move of
 * the work step into build (`update-service.ts`), where a design recorded after admission is first
 * required. The take and the build move hold `issueScope` on the project, so two of them cannot both
 * read the other as absent.
 */

import type { IssueTakeRefusalCode } from '@forge/contracts/issues';
import { type SQL, sql } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { type ScopeHoldersFilter, scopeHoldersSql } from '../db/schema-issue-designs.js';
import { liveIssueLeasesSql } from '../db/schema-issue-leases.js';
import { lockXact } from '../lib/advisory-lock.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { RefusalError } from '../lib/refusal.js';

type Reader = Pick<Tx, 'execute'>;

const SCOPE_HELD = 'ISSUE_SCOPE_HELD' satisfies IssueTakeRefusalCode;

/** One asked issue whose scope a live run holds, as the refusal names it. */
export interface ScopeHold {
  issueKey: string;
  holderKey: string;
  /** The box's own run id where the run carries one, else core's. */
  run: string;
  modules: string[];
  contracts: string[];
}

interface HoldRow {
  iss_seq: number;
  issue_prefix: string | null;
  holder_seq: number;
  run_id: string;
  box_run_id: string | null;
  module_names: string[];
  contracts: string[];
}

async function holdsWhere(
  executor: Reader,
  asked: SQL,
  filter: ScopeHoldersFilter,
): Promise<ScopeHold[]> {
  const rows = rowsOf<HoldRow>(
    await executor.execute(sql`
      SELECT mi.iss_seq, p.issue_prefix, h.holder_seq, h.run_id,
             r.metadata ->> 'boxRunId' AS box_run_id,
             ARRAY(SELECT lb.name FROM labels lb WHERE lb.id = ANY(h.modules) ORDER BY lb.name)
               AS module_names,
             h.contracts
        FROM issues mi
        JOIN projects p ON p.id = mi.project_id
        CROSS JOIN LATERAL (${scopeHoldersSql(sql`mi.id`, filter)}) h
        LEFT JOIN pipeline_runs r ON r.id = h.run_id
       WHERE ${asked}
       ORDER BY mi.iss_seq, h.holder_seq
    `),
  );
  return rows.map((r) => ({
    issueKey: formatIssueRef(r.issue_prefix, Number(r.iss_seq)),
    holderKey: formatIssueRef(r.issue_prefix, Number(r.holder_seq)),
    run: r.box_run_id ?? String(r.run_id),
    modules: [...(r.module_names ?? [])].sort(),
    contracts: [...(r.contracts ?? [])].sort(),
  }));
}

function shared(h: ScopeHold): string {
  const parts = [
    h.modules.length > 0 ? `module ${h.modules.join(', ')}` : null,
    h.contracts.length > 0 ? `contract ${h.contracts.join(', ')}` : null,
  ].filter((p): p is string => p !== null);
  return parts.join(' and ');
}

function scopeHeld(holds: readonly ScopeHold[], door: string): RefusalError {
  return new RefusalError(
    holds.map((h) => ({
      code: SCOPE_HELD,
      path: '',
      detail: `${door} is refused. ${h.issueKey} shares ${shared(h)} with ${h.holderKey}, held by live run ${h.run}. It waits until that run ends.`,
    })),
    SCOPE_HELD,
  );
}

/** Waits for the project's scope lock: a take and a build move read the holders one at a time. */
export async function lockProjectScope(executor: Reader, projectId: string): Promise<void> {
  await lockXact(executor, 'issueScope', projectId);
}

/** Refuses the issues `keys` names (canonical `ISS-n`) where a live run holds a scope they meet. */
export async function refuseScopeHeldForKeys(
  executor: Reader,
  args: { projectId: string; keys: readonly string[]; door: string; filter?: ScopeHoldersFilter },
): Promise<void> {
  if (args.keys.length === 0) return;
  const keys = sql.join(
    args.keys.map((k) => sql`${k}`),
    sql`, `,
  );
  const holds = await holdsWhere(
    executor,
    sql`mi.project_id = ${args.projectId} AND 'ISS-' || mi.iss_seq IN (${keys})`,
    { exceptKeys: args.keys, ...args.filter },
  );
  if (holds.length > 0) throw scopeHeld(holds, args.door);
}

/**
 * Refuses the move of `issueId`'s work into build while a run already building holds a scope its
 * design meets. Only building holders count, so of two admitted runs whose designs were recorded
 * after admission the first to build goes first and neither waits on the other in a circle; the
 * issue's own run, and every issue it carries, is never its holder.
 */
export async function refuseScopeHeldForBuild(
  executor: Reader,
  issue: { id: string; projectId: string },
): Promise<void> {
  await lockProjectScope(executor, issue.projectId);
  const own = rowsOf<{ run_id: string }>(
    await executor.execute(sql`
      SELECT l.run_id FROM ${liveIssueLeasesSql()} l
        JOIN issues i ON i.project_id = l.project_id AND 'ISS-' || i.iss_seq = l.issue_key
       WHERE i.id = ${issue.id}
    `),
  )[0];
  const holds = await holdsWhere(executor, sql`mi.id = ${issue.id}`, {
    exceptRunId: own?.run_id ?? null,
    buildingOnly: true,
  });
  if (holds.length > 0) throw scopeHeld(holds, 'the move of the work into build');
}
