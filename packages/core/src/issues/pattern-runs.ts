/**
 * Which run a pattern call is made from (Issue lifecycle r14 `design-check`: a new pattern is decided
 * by one reviewer, never the run that wrote it). The runs on a box share one credential, so the token
 * cannot say which run made a call. The run is the session holding the issue's lease on that box, or
 * the one the call's `run` names. A person's call is no run.
 */

import { RUN_GROUP_METADATA_KEY } from '@forge/contracts/agent-sessions';
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

/**
 * The id the plugin's `forge brief` mints for the tree a run is dispatched into, the one a dispatched
 * subagent is handed (`FORGE_SESSION_ID`): its issue keys, `+`-joined after the first, then eight hex
 * digits. contract -> github.com/SidCorp-co/forge-plugin:plugin/src/resolve/session/run-id.mjs
 * (`MINTED_FOR`).
 */
const MINTED_RUN_ID = /^iss-(\d+(?:\+\d+)*)-[0-9a-f]{8}$/i;

/** The canonical issue keys a minted run id names, or null where `run` is no minted id. */
export function mintedRunKeys(run: string): string[] | null {
  const named = MINTED_RUN_ID.exec(run.trim())?.[1];
  return named ? named.split('+').map((n) => canonicalIssueKey(Number(n))) : null;
}

type Named = { session: string } | { refusal: string };

/**
 * The fewest characters a box names one of its runs by (`runner-core` ledger `SHORT_ID_CHARS`):
 * `forge-runner status` and a master's brief show a run by its first eight, and the box resolves any
 * start that long to the one run it begins.
 */
const RUN_ID_START_MIN = 8;
const RUN_ID_START = /^[0-9a-f-]+$/;

/**
 * The live run of `box` on the project whose declared id `run` begins, as the box itself resolves a
 * short id (ISS-998, adminhub-fe FB-508: a reviewer sent run f5dc2591 as the box showed it and was
 * refused, the brief's session id accepted). Null where `run` begins no declared id; refused where it
 * is shorter than a box names a run by, or begins more than one, naming each whole id.
 */
async function declaredStartingWith(
  executor: GateReader,
  args: { projectId: string; box: string; run: string },
): Promise<Named | null> {
  const typed = args.run.trim().toLowerCase();
  if (!RUN_ID_START.test(typed)) return null;
  const held = (await executor.execute(sql`
    SELECT s.id, r.metadata->>'boxRunId' AS declared
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${args.box}
       AND s.project_id = ${args.projectId}
       AND s.status NOT IN (${terminalSessionList})
       AND starts_with(lower(r.metadata->>'boxRunId'), ${typed})
     ORDER BY s.created_at
  `)) as unknown as Array<{ id: string; declared: string }>;
  const [one, ...more] = held;
  if (!one) return null;
  const whole = held.map((h) => h.declared).join(', ');
  if (typed.length < RUN_ID_START_MIN) {
    return {
      refusal: `\`run\` ${args.run} is shorter than the ${RUN_ID_START_MIN} characters a box names a run by, so it is not taken as ${whole}: send the run's first ${RUN_ID_START_MIN} characters or its whole id`,
    };
  }
  if (more.length === 0) return { session: one.id };
  return {
    refusal: `\`run\` ${args.run} begins ${held.length} live runs this box declared on this project: ${whole}. Send enough of the id to name one, or its whole id`,
  };
}

/**
 * A live session of `box` on the project that `run` names: its session id, core's run id, or the
 * box's run id; else, where `run` is the id the plugin minted for the run's tree, the one live run
 * of this box on the project whose declared group holds every issue it names (ISS-777: a dispatched
 * judge is handed only that id, and core never learns which declared run stands in the tree). Two
 * such runs are refused naming each declared id, never one picked.
 */
async function sessionNamed(
  executor: GateReader,
  args: { projectId: string; box: string; run: string },
): Promise<Named | null> {
  const rows = (await executor.execute(sql`
    SELECT s.id
      FROM agent_sessions s
      LEFT JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${args.box}
       AND s.project_id = ${args.projectId}
       AND s.status NOT IN (${terminalSessionList})
       -- compared as text: a \`run\` that is no uuid names no session, never a failed query
       AND (s.id::text = ${args.run} OR r.id::text = ${args.run} OR r.metadata->>'boxRunId' = ${args.run})
     LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (rows[0]) return { session: rows[0].id };
  const started = await declaredStartingWith(executor, args);
  if (started) return started;
  const keys = mintedRunKeys(args.run);
  if (!keys) return null;
  const held = (await executor.execute(sql`
    SELECT s.id, COALESCE(r.metadata->>'boxRunId', r.id::text) AS declared
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${args.box}
       AND s.project_id = ${args.projectId}
       AND s.status NOT IN (${terminalSessionList})
       AND r.metadata->${RUN_GROUP_METADATA_KEY} @> ${JSON.stringify(keys)}::jsonb
     ORDER BY s.created_at
  `)) as unknown as Array<{ id: string; declared: string }>;
  const [one, ...more] = held;
  if (one && more.length === 0) return { session: one.id };
  const named = keys.join(', ');
  return {
    refusal: one
      ? `\`run\` ${args.run} is the id minted for a tree on ${named}, and ${held.length} live runs of this box on this project are declared over ${named}: ${held.map((h) => h.declared).join(', ')}. Send the run id this box declared for the run making the call`
      : `\`run\` ${args.run} is the id minted for a tree on ${named}, and no live run of this box on this project is declared over ${named}: send the run id this box declared for the run making the call, or core's id for its session or run`,
  };
}

/** The ids `box` declared for its live runs on the project, oldest first, each with the issues it was declared over. */
async function declaredOnProject(
  executor: GateReader,
  args: { projectId: string; box: string },
): Promise<string[]> {
  const rows = (await executor.execute(sql`
    SELECT COALESCE(r.metadata->>'boxRunId', r.id::text) AS declared,
           r.metadata->${RUN_GROUP_METADATA_KEY} AS run_group
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${args.box}
       AND s.project_id = ${args.projectId}
       AND s.status NOT IN (${terminalSessionList})
     ORDER BY s.created_at
  `)) as unknown as Array<{ declared: string; run_group: unknown }>;
  return rows.map((r) => {
    const keys = Array.isArray(r.run_group)
      ? r.run_group.filter((k): k is string => typeof k === 'string')
      : [];
    return keys.length > 0 ? `${r.declared} (over ${keys.join(', ')})` : r.declared;
  });
}

/**
 * The ids `box` declared for its live runs over the issue on the issue's project, oldest first, so a
 * `run` that names none of them is refused naming the ones it could have sent (an id a judge set for
 * itself, adminhub-fe ISS-112, 2026-10-30). Null where the issue is gone.
 */
async function declaredOver(
  executor: GateReader,
  args: { issueId: string; box: string },
): Promise<{ key: string; declared: string[] } | null> {
  const [issue] = (await executor.execute(
    sql`SELECT project_id, iss_seq FROM issues WHERE id = ${args.issueId}`,
  )) as unknown as Array<{ project_id: string; iss_seq: number }>;
  if (!issue) return null;
  const key = canonicalIssueKey(Number(issue.iss_seq));
  const rows = (await executor.execute(sql`
    SELECT COALESCE(r.metadata->>'boxRunId', r.id::text) AS declared
      FROM agent_sessions s
      JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.device_id = ${args.box}
       AND s.project_id = ${issue.project_id}
       AND s.status NOT IN (${terminalSessionList})
       AND r.metadata->${RUN_GROUP_METADATA_KEY} @> ${JSON.stringify([key])}::jsonb
     ORDER BY s.created_at
  `)) as unknown as Array<{ declared: string }>;
  return { key, declared: rows.map((r) => r.declared) };
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
 * on a box's, the run `run` names, or else the run holding the issue on that box, or none. A call
 * about no issue (`issueId` null: a verdict at a requirement) has no lease to read a run off, so it
 * is the run `run` names or none.
 */
export async function runOfCall(
  args: { projectId: string; issueId: string | null; box: string | null; run?: string | undefined },
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
    const named = await sessionNamed(executor, { projectId: args.projectId, box, run });
    if (named && 'session' in named) return { ok: true, value: { box, session: named.session } };
    if (named) return unknownRun(named.refusal);
    const over = args.issueId ? await declaredOver(executor, { issueId: args.issueId, box }) : null;
    const onProject = over
      ? []
      : await declaredOnProject(executor, { projectId: args.projectId, box });
    const way = over
      ? over.declared.length > 0
        ? `the live runs this box declared over ${over.key} on this project are ${over.declared.join(', ')}: send the one making the call, its whole id or its first ${RUN_ID_START_MIN} characters`
        : `this box has declared no live run over ${over.key} on this project: declare one (\`forge-runner run declare\`), or send core's id for its session or run`
      : onProject.length > 0
        ? `the live runs this box declared on this project are ${onProject.join('; ')}: send the one making the call, its whole id or its first ${RUN_ID_START_MIN} characters`
        : "this box has declared no live run on this project: declare one (`forge-runner run declare`), or send core's id for its session or run";
    return unknownRun(`\`run\` ${run} is no live session of this box on this project; ${way}`);
  }
  const session = args.issueId
    ? await leaseSessionOn(executor, { issueId: args.issueId, box })
    : null;
  return { ok: true, value: { box, session } };
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
