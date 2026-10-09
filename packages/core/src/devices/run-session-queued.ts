/**
 * A run a box declared and core refused to admit.
 *
 * The box re-sends a refused declaration every sweep while its subagent works, so before this the
 * run stood nowhere at core: runs/standing listed nothing, slots read one short, and the master's
 * count disagreed with the tracker's for as long as the refusal held (HOP run, 2026-10-05,
 * declaration 3079bf02 refused ISSUE_BLOCKED 147 times over an hour). Each refused attempt is
 * now recorded on one queued row, keyed by the box's run id: a queued run session that takes no
 * lease and carries no issue, with the refusal it is waiting behind. The open that is finally
 * admitted promotes that row; a box that stops re-sending leaves it to the reaper.
 */

import {
  RUN_GROUP_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import { and, eq, sql } from 'drizzle-orm';
import { beatSession, insertSessionRow, transitionSessions } from '../agent-sessions/index.js';
import { db, type Tx } from '../db/client.js';
import { agentSessions, pipelineRuns } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { logger } from '../lib/logger.js';
import { isRefusal } from '../lib/refusal.js';
import {
  closeRunIfOneShotInTx,
  insertOneShotRun,
  lockRunForClose,
  writeRunMetadata,
} from '../pipeline/index.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

/** The refusal a queued declaration waits behind: `{code, gate, detail, at, attempts}`. */
export const DECLARATION_REFUSAL_METADATA_KEY = 'declarationRefusal';

/** The take refusals that leave the declared run waiting rather than wrong, each with the gate
 *  word runs/standing serves it under (design agent-run-standing, waiting_gate). */
const QUEUED_BEHIND: Readonly<Record<string, string>> = {
  ISSUE_BLOCKED: 'blocked_on_issue',
  WORKFLOW_DESIGN_NOT_APPROVED: 'blocked_on_design',
  CONTRACT_WAIT_UNSETTLED: 'contract_wait_unsettled',
  PATTERN_REVIEW_PENDING: 'pattern_review_pending',
  ISSUE_LEASE_HELD: 'issue_busy',
};

export interface DeclarationRefusal {
  code: string;
  gate: string;
  detail: string;
  at: string;
  attempts: number;
}

export interface QueuedDeclarationArgs {
  deviceId: string;
  projectId: string;
  boxRunId: string;
  name: string;
  keys: string[];
  masterSessionId: string | null;
  baseMetadata: Record<string, unknown>;
}

export interface BoxRunSession {
  sessionId: string;
  runId: string;
  status: string;
}

export const declarationLockKey = (deviceId: string, boxRunId: string) => `${deviceId}:${boxRunId}`;

/** The refusal this throw is, when it is one a declared run waits behind; null otherwise. */
export function queueableRefusal(
  err: unknown,
): { code: string; gate: string; detail: string } | null {
  if (!isRefusal(err)) return null;
  for (const r of err.refusals) {
    const gate = QUEUED_BEHIND[r.code];
    if (gate) return { code: r.code, gate, detail: r.detail };
  }
  return null;
}

/** Record one refused attempt: the first opens the queued row, every later one re-stamps it. */
export async function recordRefusedDeclaration(
  args: QueuedDeclarationArgs,
  refusal: { code: string; gate: string; detail: string },
  findOpen: (tx: Tx) => Promise<BoxRunSession | null>,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    await lockXact(tx, 'runSession', declarationLockKey(args.deviceId, args.boxRunId));
    const existing = await findOpen(tx);
    if (existing && existing.status !== 'queued') return;
    if (existing) {
      await writeRunMetadata(
        existing.runId,
        {
          value: sql`jsonb_set(coalesce(${pipelineRuns.metadata}, '{}'::jsonb), ARRAY[${DECLARATION_REFUSAL_METADATA_KEY}],
            ${JSON.stringify({ ...refusal, at: now.toISOString() })}::jsonb
            || jsonb_build_object('attempts', coalesce((${pipelineRuns.metadata} -> ${DECLARATION_REFUSAL_METADATA_KEY} ->> 'attempts')::int, 0) + 1))`,
          touch: true,
        },
        tx,
      );
      await beatSession(existing.sessionId, { at: now, liveOnly: true }, tx);
      return;
    }
    const recorded: DeclarationRefusal = { ...refusal, at: now.toISOString(), attempts: 1 };
    const run = await insertOneShotRun(tx, {
      projectId: args.projectId,
      kind: 'system',
      metadata: {
        ...args.baseMetadata,
        [RUN_GROUP_METADATA_KEY]: args.keys,
        // It carries nothing until it is admitted: no lease is taken, so nothing is handed back.
        [RUN_ISSUES_METADATA_KEY]: [],
        [DECLARATION_REFUSAL_METADATA_KEY]: recorded,
      },
    });
    await insertSessionRow(tx, {
      projectId: args.projectId,
      deviceId: args.deviceId,
      pipelineRunId: run.id,
      title: `run: ${args.name}`,
      kind: RUN_SESSION_KIND,
      parentSessionId: args.masterSessionId,
      status: 'queued',
      lastHeartbeatAt: now,
      metadata: { terminalName: args.name, deviceId: args.deviceId },
    });
  });
  logger.info(
    { boxRunId: args.boxRunId, deviceId: args.deviceId, refusal: refusal.code, issues: args.keys },
    'run-session: declaration refused, recorded as a queued run behind its refusal',
  );
}

/** Promote a queued declaration to the running session the admitted open would have inserted. */
export async function promoteQueuedDeclaration(
  tx: Tx,
  queued: BoxRunSession,
  metadata: Record<string, unknown>,
): Promise<void> {
  await writeRunMetadata(
    queued.runId,
    {
      value: sql`(coalesce(${pipelineRuns.metadata}, '{}'::jsonb) - ${DECLARATION_REFUSAL_METADATA_KEY}) || ${JSON.stringify(metadata)}::jsonb`,
      touch: true,
    },
    tx,
  );
  const now = new Date();
  const moved = await transitionSessions(tx, {
    to: 'running',
    set: { startedAt: now, lastHeartbeatAt: now, updatedAt: now },
    where: and(eq(agentSessions.id, queued.sessionId), eq(agentSessions.status, 'queued')),
    reason: 'run_session_admitted',
    actor: { type: 'system' },
    source: 'run-session-open',
  });
  if (moved.rows.length === 0) {
    throw new Error(
      `openRunSession: queued declaration ${queued.sessionId} left queued while it was being admitted`,
    );
  }
}

/** Close queued declarations the box stopped re-sending: its run ended on the box, or the box is gone. */
export async function reapAbandonedDeclarations(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT s.id, s.pipeline_run_id
      FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.kind = ${RUN_SESSION_KIND} AND s.status = 'queued'
       AND r.metadata ? ${DECLARATION_REFUSAL_METADATA_KEY}
       AND COALESCE(s.last_heartbeat_at, s.created_at) < now() - make_interval(secs => ${SESSION_SILENCE_TIMEOUT_S})
  `)) as unknown as Array<{ id: string; pipeline_run_id: string }>;
  let closed = 0;
  for (const row of rows) {
    const flipped = await db.transaction(async (tx) => {
      await lockRunForClose(tx, row.pipeline_run_id);
      const moved = await transitionSessions(tx, {
        to: 'cancelled_stale',
        set: {
          failureDetail: `the box stopped re-sending this declaration for over ${SESSION_SILENCE_TIMEOUT_S}s while core still refused it, so its run ended on the box without being admitted`,
          updatedAt: new Date(),
        },
        where: and(eq(agentSessions.id, row.id), eq(agentSessions.status, 'queued')),
        reason: 'run_session_declaration_abandoned',
        actor: { type: 'system' },
        source: 'run-session-reaper',
      });
      if (moved.rows.length > 0) await closeRunIfOneShotInTx(tx, row.pipeline_run_id, 'cancelled');
      return moved.rows.length > 0;
    });
    if (flipped) closed += 1;
  }
  return closed;
}
