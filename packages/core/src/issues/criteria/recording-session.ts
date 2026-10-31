// Which run session records a verdict, or why none may. One refusal is a run core has not admitted
// (coordinator ruling 2026-10-26): adminhub-fe ISS-55's judge was declared, refused ISSUE_SCOPE_HELD
// and kept queued behind that refusal, and its box still posted verdicts naming the queued session.
// The door kept them and read them as the builder's (`VERDICT_BY_BUILDER`), when the run had been
// admitted to nothing.

import {
  RUN_DECLARATION_REFUSAL_METADATA_KEY,
  RUN_GROUP_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { liveIssueLeasesSql } from '../../db/schema-issue-leases.js';
import { runOfCall } from '../pattern-runs.js';
import type { VerdictRefusal } from './verdict-input.js';
import type { VerdictAuthor } from './verdict-record.js';

interface QueuedRow {
  box_run_id: string | null;
  run_id: string;
  project_id: string;
  refusal: { code?: string; detail?: string } | null;
}

/**
 * The live runs holding a lease on the queued run's issues, each named as its box knows it. A judge
 * queued behind ISSUE_LEASE_HELD waits for the builder to finish (forge-core-61, 2026-10-31: a
 * reviewer judges finished work), so the refusal names the run to close, not only its session.
 */
async function leaseHolderRuns(
  tx: Pick<Tx, 'execute'>,
  projectId: string,
  queuedRunId: string,
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    SELECT DISTINCT coalesce(hr.metadata ->> 'boxRunId', hr.id::text) AS run
      FROM pipeline_runs q
      CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(q.metadata -> ${RUN_GROUP_METADATA_KEY}, '[]'::jsonb)) AS k(key)
      JOIN ${liveIssueLeasesSql()} l ON l.project_id = ${projectId} AND l.issue_key = k.key
      JOIN pipeline_runs hr ON hr.id = l.run_id
     WHERE q.id = ${queuedRunId} AND l.run_id <> q.id
     ORDER BY run
  `)) as unknown as Array<{ run: string }>;
  return rows.map((r) => r.run);
}

/**
 * Where `session` is a run session still `queued`, the refusal naming it and the refusal its
 * declaration waits behind, the verdict named as `judged` says it; null for any other session.
 */
async function unadmittedDetail(
  tx: Pick<Tx, 'execute'>,
  session: string,
  judged: string,
): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    SELECT r.metadata ->> 'boxRunId' AS box_run_id, r.id AS run_id, r.project_id,
           r.metadata -> ${RUN_DECLARATION_REFUSAL_METADATA_KEY} AS refusal
      FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.id = ${session} AND s.kind = ${RUN_SESSION_KIND} AND s.status = 'queued'
  `)) as unknown as QueuedRow[];
  if (!row) return null;
  const run = row.box_run_id ?? row.run_id;
  const behind = row.refusal?.code
    ? `it waits behind ${row.refusal.code}: ${row.refusal.detail ?? 'no detail recorded'}`
    : 'it waits behind a refusal its declaration did not record';
  const said = behind.trim().endsWith('.') ? behind.trim() : `${behind.trim()}.`;
  const holders =
    row.refusal?.code === 'ISSUE_LEASE_HELD'
      ? await leaseHolderRuns(tx, row.project_id, row.run_id)
      : [];
  const next =
    holders.length > 0
      ? `Close the builder run ${holders.join(', ')} first, then record the verdict once run ${run} is admitted.`
      : 'Record the verdict once the run is admitted.';
  return `${judged} is recorded by run ${run}, which core has not admitted: its declaration is queued, and ${said} Nothing was written. ${next}`;
}

async function unadmittedFault(
  tx: Pick<Tx, 'execute'>,
  session: string,
  criterion: number,
): Promise<VerdictRefusal | null> {
  const detail = await unadmittedDetail(tx, session, `criterion ${criterion}'s verdict`);
  return detail ? { code: 'VERDICT_SESSION_NOT_ADMITTED', criterion, detail } : null;
}

type Recording = { ok: true; session: string | null } | { ok: false; refusal: VerdictRefusal };

/** Why a verdict at a requirement may not name its run, in the issue door's codes. */
export interface RunRefusal {
  code: 'VERDICT_RUN_UNKNOWN' | 'VERDICT_SESSION_NOT_ADMITTED';
  path: '/run';
  detail: string;
}

/**
 * The run session recording a verdict at a requirement (`requirements/verdicts.ts`), by the issue
 * door's rule: the `run` the call names, a live run of the calling box on this project, refused on a
 * person's call and where core has not admitted it; none on a box's call naming none, as no issue's
 * lease says which run it is.
 */
export async function requirementRecordingSessionOf(
  tx: Tx,
  args: { projectId: string; box: string | null; run?: string | undefined; judged: string },
): Promise<{ ok: true; session: string | null } | { ok: false; refusal: RunRefusal }> {
  const resolved = await runOfCall(
    { projectId: args.projectId, issueId: null, box: args.box, run: args.run },
    tx,
  );
  if (!resolved.ok) {
    const detail =
      resolved.refusals[0]?.detail ?? `\`run\` ${args.run ?? ''} names no live run of this box`;
    return { ok: false, refusal: { code: 'VERDICT_RUN_UNKNOWN', path: '/run', detail } };
  }
  const session = resolved.value.session;
  const unadmitted = session ? await unadmittedDetail(tx, session, args.judged) : null;
  if (unadmitted) {
    return {
      ok: false,
      refusal: { code: 'VERDICT_SESSION_NOT_ADMITTED', path: '/run', detail: unadmitted },
    };
  }
  return { ok: true, session };
}

/**
 * The run session recording a verdict (ISS-475): the one a door already resolved, else the `run` the
 * call names, else the session holding the issue's lease on the author's box (`pattern-runs.ts:runOfCall`,
 * as a review resolves its reviewer). A `run` naming no live session of the box is refused, and so
 * is a session core has not admitted.
 */
export async function recordingSessionOf(
  tx: Tx,
  args: {
    issue: { id: string; projectId: string };
    criterion: number;
    author: VerdictAuthor;
    run?: string | undefined;
    runSession?: string | null | undefined;
  },
): Promise<Recording> {
  const admitted = async (session: string | null): Promise<Recording> => {
    const fault = session ? await unadmittedFault(tx, session, args.criterion) : null;
    return fault ? { ok: false, refusal: fault } : { ok: true, session };
  };
  if (args.runSession !== undefined) return admitted(args.runSession);
  const resolved = await runOfCall(
    {
      projectId: args.issue.projectId,
      issueId: args.issue.id,
      box: args.author.deviceId,
      run: args.run,
    },
    tx,
  );
  if (resolved.ok) return admitted(resolved.value.session);
  const [first] = resolved.refusals;
  return {
    ok: false,
    refusal: {
      code: 'VERDICT_RUN_UNKNOWN',
      criterion: args.criterion,
      detail: first?.detail ?? `\`run\` ${args.run ?? ''} names no live run of this box`,
    },
  };
}
