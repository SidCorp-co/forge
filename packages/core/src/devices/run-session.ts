/**
 * A run session as core knows about it (ISS-933 wave 2).
 *
 * A run is a terminal session the master creates, carrying a GROUP of issues.
 * It mints no `drive` job and opens no `issue`-kind run, so the pool cannot see
 * it and no master is ever offered it. What it does have is an `agent_sessions`
 * row, because two things need one: a run that never reaches terminal is the
 * ghost this issue's own *Đóng vòng* section counts (96 of 125 on the fleet),
 * and the box's SQLite ledger cannot answer for a box that has lost power.
 *
 * The ledger is the fast path. This is the one that survives the box.
 */

import { and, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { agentSessions, devices, issues, terminalAgentSessionStatuses } from '../db/schema.js';
import { applyKernelTransition } from '../lifecycle/transition.js';
import { logger } from '../logger.js';
import { openOneShotRun } from '../pipeline/runs.js';

/** What `metadata.type` a run session carries. */
// cm:guard the discriminator is `metadata.type`, the same key chat, pipeline and master sessions use, so every reader that partitions on it keeps working and a run shows up in the project's session list rather than in a private table nobody looks at.
export const RUN_SESSION_TYPE = 'run';

/**
 * How long a box may go unheard before core frees what its runs were holding.
 *
 * The failure this covers is the one `master-reaper.ts`'s own header names: a
 * box that loses power drops no socket and writes no ledger row anyone can
 * read. Longer than the device heartbeat interval by a wide margin, because
 * the cost of being wrong is taking an issue off a live run.
 */
// cm:guard this must stay LONGER than `MASTER_HOLD_TIMEOUT_MS`, and the reason is not symmetry. Releasing a job HOLD is free — the job is still queued and is simply offered again. Terminating a run session takes an issue away from a session that may be mid-diff, so it needs the slower clock and the harder evidence.
export const RUN_SESSION_HOST_TIMEOUT_MS = 15 * 60 * 1000;

export interface RunSessionCreated {
  ok: true;
  sessionId: string;
  name: string;
}

export interface RunSessionRefused {
  ok: false;
  reason: 'issue_in_live_run';
  issueId: string;
  heldBySessionId: string;
}

/** Every issue a live run session on this project is carrying. */
// cm:guard the membership is read out of `metadata.issueIds`, a jsonb array, and it is MANY per row on purpose. A column would encode the default this change exists to reverse — one issue per run — and would make a group of three unrepresentable rather than merely awkward.
async function liveRunHolderFor(
  projectId: string,
  issueIds: string[],
): Promise<{ issueId: string; sessionId: string } | null> {
  if (issueIds.length === 0) return null;
  const rows = await db
    .select({ id: agentSessions.id, metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    );
  for (const row of rows) {
    const held = (row.metadata as { issueIds?: unknown } | null)?.issueIds;
    if (!Array.isArray(held)) continue;
    const clash = issueIds.find((id) => held.includes(id));
    if (clash) return { issueId: clash, sessionId: row.id };
  }
  return null;
}

/**
 * Register a run session for one group of issues, or refuse by name.
 *
 * Refusing here is the central half of the invariant the ledger enforces
 * locally: one live run per issue. Two boxes cannot see each other's ledgers,
 * so without this a fleet-wide double-claim is a thing that can be written.
 */
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/runner/ledger.rs — `create_run_for_group` refuses the same two things locally and this refuses the first of them centrally. The local one is the fast path and answers before a worktree is made; this one is what a SECOND BOX is bound by. Dropping either leaves the invariant true only where it happens to be checked.
export async function createRunSession(args: {
  deviceId: string;
  projectId: string;
  name: string;
  issueIds: string[];
  worktreePath: string;
}): Promise<RunSessionCreated | RunSessionRefused> {
  const clash = await liveRunHolderFor(args.projectId, args.issueIds);
  if (clash) {
    return {
      ok: false,
      reason: 'issue_in_live_run',
      issueId: clash.issueId,
      heldBySessionId: clash.sessionId,
    };
  }

  // cm:guard a `kind='system'` one-shot run, never an `issue` one. `agent_sessions.pipeline_run_id` is NOT NULL (migration 0054), so a row cannot exist without one; an `issue`-kind run is what the partial unique index, the issue-run reaper and every dispatch gate key on, and opening one here would put a run session back on the dispatch rail this change takes it off.
  const run = await openOneShotRun({
    projectId: args.projectId,
    kind: 'system',
    metadata: { type: RUN_SESSION_TYPE, deviceId: args.deviceId },
  });
  const [row] = await db
    .insert(agentSessions)
    .values({
      projectId: args.projectId,
      deviceId: args.deviceId,
      pipelineRunId: run.id,
      title: `run: ${args.name}`,
      status: 'running',
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      repoPath: args.worktreePath,
      metadata: {
        type: RUN_SESSION_TYPE,
        terminalName: args.name,
        deviceId: args.deviceId,
        issueIds: args.issueIds,
        worktreePath: args.worktreePath,
      },
    })
    .returning({ id: agentSessions.id });
  if (!row) throw new Error('createRunSession: insert returned no row');

  logger.info(
    {
      runSessionId: row.id,
      deviceId: args.deviceId,
      projectId: args.projectId,
      name: args.name,
      issueCount: args.issueIds.length,
    },
    'run-session: registered a run carrying a group',
  );
  return { ok: true, sessionId: row.id, name: args.name };
}

/** Close a run session this device owns, and say why. */
// cm:guard refuse to close a session this device does not own. Every paired runner in the fleet holds a valid credential, so without the ownership check any box could terminate another box's run and take the issues it is mid-diff on.
export async function closeRunSession(args: {
  deviceId: string;
  sessionId: string;
  reason: string;
}): Promise<boolean> {
  const rows = await applyKernelTransition(db, {
    entity: 'session',
    to: 'completed',
    set: { failureDetail: args.reason, updatedAt: new Date() },
    where: and(
      eq(agentSessions.id, args.sessionId),
      eq(agentSessions.deviceId, args.deviceId),
      sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
      notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
    ),
    fromStatus: 'running',
    reason: 'run_session_ended',
    actor: { type: 'system' },
    source: 'run-session',
  });
  return rows.length > 0;
}

/**
 * Free the runs of boxes core has not heard from, so their issues come back.
 *
 * Criterion 25a: a design in which the unreachable box is the only thing that
 * can release its own work has no answer for a box that lost power, however
 * well it handles a dead pane.
 */
// cm:guard keyed on the DEVICE's heartbeat, never on the session's. A run session's own `lastHeartbeatAt` is written by the box, so a box that vanished stops writing both — but the session clock would also fire for a run that is simply thinking for twenty minutes with a healthy host, which is the common case and is not a failure. The device row is the thing that says "this machine is gone".
// cm:edge lockstep -> packages/core/src/devices/master-reaper.ts — the two are the same shape on different objects and BOTH must survive this issue. That one gives back job HOLDS on a 3-minute clock for the four kinds that still mint jobs; this one terminates RUN SESSIONS on a slower one. Deleting either leaves half the fleet's work unrecoverable when a box vanishes.
export async function reapRunSessionsOfUnreachableHosts(): Promise<number> {
  const staleSeconds = Math.floor(RUN_SESSION_HOST_TIMEOUT_MS / 1000);
  const doomed = await db
    .select({ id: agentSessions.id, deviceId: agentSessions.deviceId })
    .from(agentSessions)
    .innerJoin(devices, eq(devices.id, agentSessions.deviceId))
    .where(
      and(
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
        or(
          sql`${devices.lastSeenAt} IS NULL`,
          lt(devices.lastSeenAt, sql`now() - make_interval(secs => ${staleSeconds})`),
        ),
      ),
    );
  if (doomed.length === 0) return 0;

  const rows = await applyKernelTransition(db, {
    entity: 'session',
    to: 'failed',
    set: {
      failureDetail: 'the box hosting this run stopped answering; its issues are free again',
      updatedAt: new Date(),
    },
    where: inArray(
      agentSessions.id,
      doomed.map((d) => d.id),
    ),
    fromStatus: 'running',
    reason: 'run_host_unreachable',
    actor: { type: 'system' },
    source: 'run-session',
  });
  for (const row of rows) {
    logger.warn(
      { runSessionId: String(row.id) },
      'run-session: host unreachable, the run is terminal and its issues are free',
    );
  }
  return rows.length;
}

export const RUN_SESSION_REAPER_QUEUE = 'run-session-host-reaper';

let registered = false;

export async function registerRunSessionReaper(): Promise<void> {
  if (registered) return;
  const { boss } = await import('../queue/boss.js');
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).createQueue(RUN_SESSION_REAPER_QUEUE);
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).work(RUN_SESSION_REAPER_QUEUE, async () => {
    const freed = await reapRunSessionsOfUnreachableHosts();
    if (freed > 0) logger.info({ freed }, 'run-session: sweep freed runs of unreachable boxes');
  });
  // biome-ignore lint/suspicious/noExplicitAny: pg-boss types vary across versions
  await (boss as any).schedule(RUN_SESSION_REAPER_QUEUE, '* * * * *');
  registered = true;
}

export function resetRunSessionReaperForTest(): void {
  registered = false;
}

/** The issues a live run session is carrying, for whoever asks core. */
export async function issuesInLiveRuns(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.projectId, projectId),
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    );
  const out = new Set<string>();
  for (const row of rows) {
    const held = (row.metadata as { issueIds?: unknown } | null)?.issueIds;
    if (Array.isArray(held)) for (const id of held) out.add(String(id));
  }
  return [...out];
}

/**
 * Give ONE issue's lease back and answer who holds it now.
 *
 * The answer is a separate read, deliberately: the response to a write says the
 * write was accepted, and the mark this feeds must be set from who holds the
 * lease rather than from how the return call went.
 */
// cm:guard the UPDATE is scoped to `lease.holder = this run session`, and widening it is not a convenience. The lease is written by `forge claim` in github.com/SidCorp-co/forge-plugin and core has no other reader — a clear that did not check the holder would let one box return a lease another box's live run is working under, and nothing in either repo would report it.
// cm:guard per ISSUE and never per run. A run carrying three issues holds three leases; one call that returned "the run's lease" could only ever be all-or-nothing, and the measured defect is precisely a partial return being reported as a whole one.
export async function returnLeaseForIssue(args: {
  deviceId: string;
  sessionId: string;
  issueId: string;
}): Promise<{ holder: string | null } | null> {
  const [session] = await db
    .select({ id: agentSessions.id, metadata: agentSessions.metadata })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.deviceId, args.deviceId),
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
      ),
    );
  if (!session) return null;
  const held = (session.metadata as { issueIds?: unknown } | null)?.issueIds;
  if (!Array.isArray(held) || !held.includes(args.issueId)) return null;

  await db.execute(sql`
    UPDATE issues
    SET session_context = session_context - 'lease'
    WHERE id = ${args.issueId}
      AND session_context->'lease'->>'holder' = ${args.sessionId}
  `);

  const [row] = await db
    .select({ ctx: issues.sessionContext })
    .from(issues)
    .where(eq(issues.id, args.issueId));
  const holder = (row?.ctx as { lease?: { holder?: unknown } } | null)?.lease?.holder;
  return { holder: typeof holder === 'string' ? holder : null };
}
