/**
 * Which run a pattern call is made from (Issue lifecycle r14 `design-check`: a new pattern is decided
 * by one reviewer, never the run that wrote it). The runs on a box share one credential, so the token
 * cannot say which run made a call. The run is the session holding the issue's lease on that box, or
 * the one the call's `run` names. A person's call is no run.
 */

import type { PatternRefusal } from '@forge/contracts/patterns';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { terminalSessionList } from './issue-lease.js';
import type { GateReader } from './ports.js';

/** `box` is the device a box credential belongs to; `session` the run session the call is. */
export interface CallRun {
  box: string | null;
  session: string | null;
}

type Resolved = { ok: true; value: CallRun } | { ok: false; refusals: PatternRefusal[] };

const unknownRun = (detail: string): Resolved => ({
  ok: false,
  refusals: [{ code: 'PATTERN_RUN_UNKNOWN', path: '/run', detail }],
});

/** A live session of `box` on the project that `run` names: its session id, core's run id, or the box's run id. */
async function sessionNamed(
  executor: GateReader,
  args: { projectId: string; box: string; run: string },
): Promise<string | null> {
  const rows = (await executor.execute(sql`
    SELECT s.id
      FROM agent_sessions s
      LEFT JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${args.box}
       AND s.project_id = ${args.projectId}
       AND s.status NOT IN (${terminalSessionList})
       AND (s.id = ${args.run} OR r.id = ${args.run} OR r.metadata->>'boxRunId' = ${args.run})
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** The live session holding the issue's lease on `box`, or null where this box holds none. */
async function leaseSessionOn(
  executor: GateReader,
  args: { issueId: string; box: string },
): Promise<string | null> {
  const [issue] = (await executor.execute(
    sql`SELECT project_id, iss_seq FROM issues WHERE id = ${args.issueId}`,
  )) as unknown as Array<{ project_id: string; iss_seq: number }>;
  if (!issue) return null;
  const rows = (await executor.execute(sql`
    SELECT l.session_id
      FROM issue_leases l
      JOIN agent_sessions s ON s.id = l.session_id
     WHERE l.project_id = ${issue.project_id}
       AND l.issue_key = ${canonicalIssueKey(Number(issue.iss_seq))}
       AND l.device_id = ${args.box}
       AND s.status NOT IN (${terminalSessionList})
     LIMIT 1
  `)) as unknown as Array<{ session_id: string }>;
  return rows[0]?.session_id ?? null;
}

/**
 * The run this call is: on a person's credential none (and `run` is refused, a person being no run);
 * on a box's, the run `run` names, or else the run holding the issue on that box, or none.
 */
export async function runOfCall(
  args: { projectId: string; issueId: string; box: string | null; run?: string | undefined },
  executor: GateReader = db,
): Promise<Resolved> {
  const { box, run } = args;
  if (box === null) {
    if (run === undefined) return { ok: true, value: { box: null, session: null } };
    return unknownRun(
      `this call carries a person's credential, not a box's, so it is made by no run and \`run\` (${run}) names nothing it could be. Leave \`run\` out to act as yourself`,
    );
  }
  if (run !== undefined) {
    const session = await sessionNamed(executor, { projectId: args.projectId, box, run });
    if (session) return { ok: true, value: { box, session } };
    return unknownRun(
      `\`run\` ${run} is no live session of this box on this project: send the run id this box declared for the run making the call, or core's id for its session or run`,
    );
  }
  return {
    ok: true,
    value: { box, session: await leaseSessionOn(executor, { issueId: args.issueId, box }) },
  };
}

/** Whether `session` is still a live session on `box`. */
export async function liveOnBox(
  session: string,
  box: string,
  executor: GateReader = db,
): Promise<boolean> {
  const rows = (await executor.execute(sql`
    SELECT 1 FROM agent_sessions
     WHERE id = ${session} AND device_id = ${box} AND status NOT IN (${terminalSessionList})
  `)) as unknown as unknown[];
  return rows.length > 0;
}
