// Which run session records a verdict, or why none may. One refusal is a run core has not admitted
// (coordinator ruling 2026-10-26): adminhub-fe ISS-55's judge was declared, refused ISSUE_SCOPE_HELD
// and kept queued behind that refusal, and its box still posted verdicts naming the queued session.
// The door kept them and read them as the builder's (`VERDICT_BY_BUILDER`), when the run had been
// admitted to nothing.

import {
  RUN_DECLARATION_REFUSAL_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { runOfCall } from '../pattern-runs.js';
import type { VerdictRefusal } from './verdict-input.js';
import type { VerdictAuthor } from './verdict-record.js';

interface QueuedRow {
  box_run_id: string | null;
  run_id: string;
  refusal: { code?: string; detail?: string } | null;
}

/**
 * Where `session` is a run session still `queued`, the refusal naming it and the refusal its
 * declaration waits behind; null for any other session.
 */
async function unadmittedFault(
  tx: Pick<Tx, 'execute'>,
  session: string,
  criterion: number,
): Promise<VerdictRefusal | null> {
  const [row] = (await tx.execute(sql`
    SELECT r.metadata ->> 'boxRunId' AS box_run_id, r.id AS run_id,
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
  return {
    code: 'VERDICT_SESSION_NOT_ADMITTED',
    criterion,
    detail: `criterion ${criterion}'s verdict is recorded by run ${run}, which core has not admitted: its declaration is queued, and ${said} Nothing was written. Record the verdict once the run is admitted.`,
  };
}

type Recording = { ok: true; session: string | null } | { ok: false; refusal: VerdictRefusal };

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
