// cm:why the rows a page of runs is derived from, one statement per table (design agent-run-standing rev 1,
// ISS-108): pipeline_runs, jobs, agent_sessions and the run ledger; the claim blob, the fleet key and deploy
// locks; questions, release approvals and the kernel's own transitions

import type { IssueStatus } from '@forge/contracts/issue-machine';
import { type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { masterLastBeatSql } from '../devices/master-silence.js';
import { RUN_GROUP_METADATA_KEY } from '../devices/run-session-keys.js';
import {
  MASTER_SESSION_KIND,
  PIPELINE_SESSION_KINDS,
  RUN_SESSION_KIND,
} from '../jobs/session-kinds.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { groupOf, laneOf, type PipelineRunLane } from '../pipeline/runs-lane.js';
import { loadRunLivenessByRunIds, type RunLiveness } from '../pipeline/runs-liveness.js';
import { TERMINAL_PIPELINE_RUN_STATUSES } from '@forge/contracts/run-machine';
import type { KernelFlip, RunFacts } from './standing-types.js';

export type Row = Record<string, unknown>;
export const rowsOf = <T = Row>(r: unknown) => [...(r as Iterable<T>)];
export const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : String(v);
export const must = (v: unknown): Date => new Date(String(v));
export const date = (v: unknown): Date | null =>
  v === null || v === undefined ? null : new Date(String(v));

const uuids = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
const texts = (values: readonly string[]) =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
const q = (s: SQL) => db.execute(s).then((r) => rowsOf(r));
const when = (ok: boolean, s: () => Promise<Row[]>) => (ok ? s() : Promise.resolve([] as Row[]));

// cm:why a run here is a pipeline run a person reads on Agents / Runs: a chat's one-shot run is a conversation,
// and a master's own run is the master, served by masters/standing beside the list; the master is read off its
// session's `kind` column, never a jsonb key (jobs/session-kinds.test.ts)
export const MASTER_RUN_SQL = sql`r.issue_id IS NULL AND EXISTS (
  SELECT 1 FROM agent_sessions ms WHERE ms.pipeline_run_id = r.id AND ms.kind = ${MASTER_SESSION_KIND})`;
export const RUN_SCOPE_SQL = sql`r.kind <> 'interactive' AND NOT (${MASTER_RUN_SQL})`;

export const BASE_COLUMNS = sql`r.id, r.project_id, r.issue_id, r.kind, r.status, r.current_step, r.started_at,
  r.finished_at, r.updated_at, r.metadata, r.release_version, i.iss_seq, i.title AS issue_title, i.status AS issue_status`;

export interface BaseRun extends Row {
  id: string;
  project_id: string;
  issue_id: string | null;
  status: RunFacts['run']['status'];
  current_step: string | null;
  started_at: string | Date;
  finished_at: string | Date | null;
  updated_at: string | Date;
  metadata: unknown;
  release_version: string | null;
  iss_seq: number | null;
  issue_title: string | null;
  issue_status: IssueStatus | null;
}

export const seqOf = (key: string) => {
  const n = Number.parseInt(key.replace(/^[A-Za-z]+-/, ''), 10);
  return Number.isInteger(n) ? n : null;
};

export interface Tables {
  groups: Map<string, { lane: PipelineRunLane; keys: string[] }>;
  sessionByRun: Map<string, Row>;
  jobByRun: Map<string, Row>;
  liveness: Map<string, RunLiveness>;
  leases: Row[];
  locks: Row[];
  approvals: Row[];
  releases: Row[];
  runFlips: Map<string, KernelFlip>;
  attempts: Map<string, { n: number; retryOf: string | null; workKey: string }>;
  issueBySeq: Map<number, Row>;
  phases: Row[];
  ledgerBySession: Map<string, Row>;
  sessionFlips: Map<string, KernelFlip>;
  questions: Row[];
  masterById: Map<string, Row>;
  passes: Row[];
  issueMoves: Row[];
}

async function latestFlips(entity: 'run' | 'session', ids: string[], to: readonly string[]) {
  if (ids.length === 0) return new Map<string, KernelFlip>();
  const rows = await q(sql`
    SELECT DISTINCT ON (entity_id) entity_id, to_status, reason, actor_type, actor_agency, actor_id, created_at
      FROM kernel_transitions
     WHERE entity = ${entity} AND entity_id IN (${uuids(ids)}) AND to_status IN (${texts(to)})
     ORDER BY entity_id, created_at DESC`);
  const names = await peopleOf(rows.map((r) => str(r.actor_id)));
  return new Map(
    rows.map((r): [string, KernelFlip] => {
      const user = r.actor_type === 'user' ? str(r.actor_id) : null;
      return [
        String(r.entity_id),
        {
          toStatus: String(r.to_status),
          reason: str(r.reason),
          actorType: r.actor_type as KernelFlip['actorType'],
          agency: r.actor_agency as KernelFlip['agency'],
          userId: user,
          name: user ? (names.get(user)?.name ?? null) : null,
          at: must(r.created_at),
        },
      ];
    }),
  );
}

// cm:why an attempt is a run: the nth run over the same issue in this project, its retryOf the run before it
// (decision on agent-run-standing: the next attempt is a new run); a group run counts under its first issue,
// keyed by sequence number so the key itself is built only by `lib/issue-ref.ts`
async function attemptsOf(projectId: string, ids: string[]) {
  const rows = await q(sql`
    WITH keyed AS (
      SELECT r.id, r.started_at,
             COALESCE(i.iss_seq, CASE
               WHEN r.metadata -> ${RUN_GROUP_METADATA_KEY} ->> 0 ~ '^[A-Za-z]+-[0-9]+$'
               THEN regexp_replace(r.metadata -> ${RUN_GROUP_METADATA_KEY} ->> 0, '^[A-Za-z]+-', '')::int
             END) AS work_seq
        FROM pipeline_runs r LEFT JOIN issues i ON i.id = r.issue_id
       WHERE r.project_id = ${projectId} AND ${RUN_SCOPE_SQL}
    ), ranked AS (
      SELECT id, work_seq,
             row_number() OVER (PARTITION BY work_seq ORDER BY started_at, id) AS n,
             lag(id) OVER (PARTITION BY work_seq ORDER BY started_at, id) AS retry_of
        FROM keyed WHERE work_seq IS NOT NULL
    )
    SELECT id, work_seq, n, retry_of FROM ranked WHERE id IN (${uuids(ids)})`);
  return new Map(
    rows.map((r) => [
      String(r.id),
      {
        n: Number(r.n),
        retryOf: str(r.retry_of),
        workKey: canonicalIssueKey(Number(r.work_seq)),
      },
    ]),
  );
}

function groupsOf(base: BaseRun[]) {
  return new Map(
    base.map((b) => {
      const lane = laneOf({ issueId: b.issue_id, metadata: b.metadata });
      const keys =
        b.iss_seq !== null
          ? [canonicalIssueKey(b.iss_seq)]
          : groupOf({ metadata: b.metadata }, lane).issues;
      return [b.id, { lane, keys }] as const;
    }),
  );
}

function runRows(projectId: string, ids: string[]) {
  return Promise.all([
    q(sql`
      SELECT DISTINCT ON (s.pipeline_run_id) s.id, s.pipeline_run_id, s.status, s.runtime_state,
             s.failure_reason, s.failure_detail, s.last_heartbeat_at, s.started_at, s.created_at,
             s.updated_at, s.device_id, d.name AS device_name, s.metadata->>'terminalName' AS name,
             s.parent_session_id
        FROM agent_sessions s LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.pipeline_run_id IN (${uuids(ids)}) AND s.kind = ${RUN_SESSION_KIND}
       ORDER BY s.pipeline_run_id, s.created_at DESC`),
    q(sql`
      SELECT DISTINCT ON (j.pipeline_run_id) j.id, j.pipeline_run_id, j.type, j.status, j.held_by,
             j.held_at, j.payload -> '__hold' AS hold, j.retry_after_at, j.failure_reason, j.queued_at,
             j.dispatched_at, j.acked_at, j.finished_at, j.device_id, d.name AS device_name,
             j.agent_session_id, s.last_heartbeat_at AS session_beat,
             s.failure_reason AS session_failure_reason, s.failure_detail AS session_failure_detail,
             s.status AS session_status, s.runtime_state AS session_runtime_state,
             s.started_at AS session_started_at, s.updated_at AS session_updated_at,
             s.created_at AS session_created_at,
             (s.kind IN (${sql.join(
               PIPELINE_SESSION_KINDS.map((k) => sql`${k}`),
               sql`, `,
             )}) OR s.metadata -> 'escalation' IS NOT NULL
               OR s.metadata -> 'agentChat' IS NOT NULL) AS session_heartbeat_reaped,
             EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id) AS job_has_events
        FROM jobs j
        LEFT JOIN devices d ON d.id = j.device_id
        LEFT JOIN agent_sessions s ON s.id = j.agent_session_id
       WHERE j.pipeline_run_id IN (${uuids(ids)})
       ORDER BY j.pipeline_run_id, j.queued_at DESC, j.created_at DESC`),
    loadRunLivenessByRunIds(ids),
    q(sql`
      SELECT run_id, issue_key, session_id, acquired_at FROM issue_leases
       WHERE run_id IN (${uuids(ids)})`),
    q(sql`
      SELECT run_id, environment, subject, acquired_at, expires_at, reclaimed_from_run_id
        FROM deploy_locks WHERE project_id = ${projectId} AND run_id IN (${uuids(ids)})`),
    q(sql`
      SELECT run_id, id, requested_at FROM release_approvals
       WHERE run_id IN (${uuids(ids)}) AND decision IS NULL ORDER BY requested_at`),
    q(sql`
      SELECT DISTINCT ON (run_id) run_id, stage, verdict, started_at FROM release_attempts
       WHERE run_id IN (${uuids(ids)}) ORDER BY run_id, started_at DESC`),
    latestFlips('run', ids, TERMINAL_PIPELINE_RUN_STATUSES),
    attemptsOf(projectId, ids),
    q(sql`
      SELECT DISTINCT ON (run_id) run_id, phase FROM phase_journal
       WHERE ended_at IS NULL AND run_id IN (${uuids(ids)})
       ORDER BY run_id, started_at DESC, attempt DESC`),
  ]);
}

function issueRowsOf(projectId: string, seqs: number[]) {
  return when(seqs.length > 0, () =>
    q(sql`
      SELECT i.id, i.iss_seq, i.title, i.status, w.step, w.step_started_at, w.lease,
             i.session_context -> 'strand' AS strand,
             (SELECT max(kt.created_at) FROM kernel_transitions kt
               WHERE kt.entity = 'issue' AND kt.entity_id = i.id AND kt.to_status = i.status)
               AS status_since
        FROM issues i LEFT JOIN issue_work_state w ON w.issue_id = i.id
       WHERE i.project_id = ${projectId} AND i.iss_seq IN (${sql.join(
         seqs.map((n) => sql`${n}`),
         sql`, `,
       )})`),
  );
}

function holderRows(
  projectId: string,
  args: { sessionIds: string[]; issueIds: string[]; masterIds: string[]; since: string },
) {
  const { sessionIds, issueIds, masterIds, since } = args;
  return Promise.all([
    when(sessionIds.length > 0, () =>
      q(sql`
        SELECT DISTINCT ON (session_id) session_id, incarnation, work, blocker_kind, waiting_on, observed_at
          FROM device_run_ledger WHERE session_id IN (${uuids(sessionIds)})
         ORDER BY session_id, observed_at DESC`),
    ),
    latestFlips('session', sessionIds, terminalAgentSessionStatuses),
    when(sessionIds.length + issueIds.length > 0, () =>
      q(sql`
        SELECT id, agent_session_id, issue_id, created_at, steps FROM agent_questions
         WHERE project_id = ${projectId} AND status = 'open' AND blocker_kind = 'human'
           AND (${sessionIds.length ? sql`agent_session_id IN (${uuids(sessionIds)})` : sql`false`}
             OR ${issueIds.length ? sql`issue_id IN (${uuids(issueIds)})` : sql`false`})
         ORDER BY created_at`),
    ),
    when(masterIds.length > 0, () =>
      q(sql`
        SELECT s.id, COALESCE(s.metadata->>'terminalName', s.title) AS name,
               s.status NOT IN (${texts(terminalAgentSessionStatuses)}) AS live,
               ${masterLastBeatSql('s')} AS last_beat
          FROM agent_sessions s WHERE s.id IN (${uuids(masterIds)})`),
    ),
    when(masterIds.length > 0, () =>
      q(sql`
        SELECT id, master_session_id, verb, started_at, ended_at FROM master_passes
         WHERE master_session_id IN (${uuids(masterIds)})
           AND (ended_at IS NULL OR ended_at >= ${since}::timestamptz)
         ORDER BY started_at DESC`),
    ),
    when(issueIds.length > 0, () =>
      q(sql`
        SELECT entity_id, to_status, created_at FROM kernel_transitions
         WHERE entity = 'issue' AND entity_id IN (${uuids(issueIds)})
           AND created_at >= ${since}::timestamptz
         ORDER BY created_at`),
    ),
  ]);
}

const byKey = (rows: Row[], key: string) => new Map(rows.map((r) => [String(r[key]), r]));

export async function readTables(projectId: string, base: BaseRun[]): Promise<Tables> {
  const ids = base.map((b) => b.id);
  const groups = groupsOf(base);
  const seqs = [
    ...new Set(
      [...groups.values()].flatMap((g) => g.keys.map(seqOf)).filter((n): n is number => n !== null),
    ),
  ];
  const [
    [sessions, jobs, liveness, leases, locks, approvals, releases, runFlips, attempts, phases],
    issues,
  ] = await Promise.all([runRows(projectId, ids), issueRowsOf(projectId, seqs)]);
  const masterIds = [
    ...new Set(
      [...sessions.map((s) => str(s.parent_session_id)), ...jobs.map((j) => str(j.held_by))].filter(
        (v): v is string => v !== null,
      ),
    ),
  ];
  const since = new Date(Math.min(...base.map((b) => must(b.started_at).getTime()))).toISOString();
  const [ledgers, sessionFlips, questions, masters, passes, issueMoves] = await holderRows(
    projectId,
    {
      sessionIds: sessions.map((s) => String(s.id)),
      issueIds: issues.map((i) => String(i.id)),
      masterIds,
      since,
    },
  );
  return {
    groups,
    sessionByRun: byKey(sessions, 'pipeline_run_id'),
    jobByRun: byKey(jobs, 'pipeline_run_id'),
    liveness,
    leases,
    locks,
    approvals,
    releases,
    runFlips,
    attempts,
    issueBySeq: new Map(issues.map((i) => [Number(i.iss_seq), i])),
    phases,
    ledgerBySession: byKey(ledgers, 'session_id'),
    sessionFlips,
    questions,
    masterById: byKey(masters, 'id'),
    passes,
    issueMoves,
  };
}
