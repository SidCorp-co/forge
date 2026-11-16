/**
 * The shell around `run-slots.ts:slotsFor` (ISS-1245): it reads what one box holds now, asks the
 * rule, and refuses a run its project has no free slot for. Nothing else here decides a count.
 *
 * - capacity: `devices.max_subagents`, which the box's runner declares beside `max_job_panes`;
 *   undeclared, it is 0, and the rule then gives each project with work its floor of 1 alone;
 * - in use: the box's run sessions that are running or idle, per project. A queued declaration
 *   holds nothing, so it is not counted;
 * - waiting: each bound project's admissible issues (`admissible.ts`), the parts nobody started,
 *   urgent where one of them is critical or high.
 *
 * A slot is claimed by `run declare` (this door answers its preflight and its open) and given back
 * by the run's close; no row of its own exists.
 */

import {
  RUN_DECLARATION_REFUSAL_METADATA_KEY,
  RUN_SESSION_KIND,
} from '@forge/contracts/agent-sessions';
import type { MasterSubagentSlots } from '@forge/contracts/master-standing';
import { STARTED_SESSION_STATUSES } from '@forge/contracts/session-machine';
import { eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { memoizedRead } from '../db/read-memo.js';
import { devices } from '../db/schema.js';
import { lockXact } from '../lib/advisory-lock.js';
import { readAdmissibleIssues } from './admissible.js';
import { devicesPorts } from './ports.js';
import { refuseDevice } from './refusals.js';
import { type SlotDemand, slotsFor } from './run-slots.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

/** The run-session statuses that hold a subagent slot: a queued declaration runs nothing yet. */
const HOLDING = STARTED_SESSION_STATUSES;
const URGENT = new Set(['critical', 'high']);

export interface ProjectSlots {
  projectId: string;
  /** What the rule was asked for: its runs in use and the work waiting for one, a steward job's included. */
  wants: number;
  /** What `slotsFor` gives the project on this box now. */
  slots: number;
  /** Its run sessions holding a subagent on this box now. */
  inUse: number;
  /** Its admissible issues nobody has started. */
  waiting: number;
  urgent: boolean;
}

export interface BoxSlots {
  /** `devices.max_subagents`; null where the box's runner has not declared it. */
  capacity: number | null;
  projects: ProjectSlots[];
}

type Executor = Pick<Tx, 'select' | 'execute'>;

async function inUseByProject(executor: Executor, deviceId: string): Promise<Map<string, number>> {
  const rows = (await executor.execute(sql`
    SELECT s.project_id::text AS project_id, count(*)::int AS runs
      FROM agent_sessions s
     WHERE s.device_id = ${deviceId}
       AND s.kind = ${RUN_SESSION_KIND}
       AND s.status IN (${sql.join(
         HOLDING.map((h) => sql`${h}`),
         sql`, `,
       )})
       AND s.project_id IS NOT NULL
     GROUP BY s.project_id`)) as unknown as Array<{ project_id: string; runs: number }>;
  return new Map([...rows].map((r) => [r.project_id, Number(r.runs)]));
}

/**
 * Every project's slots on this box. `declaring` is a project asking for one more: it counts as
 * having work even where none of its issues is admissible (a judge over closed issues, a run over
 * an issue already in progress), since the declaration is that work.
 */
export async function readBoxSlots(
  deviceId: string,
  opts: { declaring?: string; executor?: Executor } = {},
): Promise<BoxSlots> {
  const executor = opts.executor ?? db;
  const [[device], inUse, admissible, steward] = await Promise.all([
    executor
      .select({ maxSubagents: devices.maxSubagents })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1),
    inUseByProject(executor, deviceId),
    readAdmissibleIssues({ deviceId }),
    devicesPorts().stewardSlotDemand(executor, deviceId),
  ]);
  const waiting = new Map<string, { n: number; urgent: boolean }>();
  for (const item of admissible.items) {
    const held = waiting.get(item.projectId) ?? { n: 0, urgent: false };
    waiting.set(item.projectId, {
      n: held.n + 1,
      urgent: held.urgent || URGENT.has(item.priority ?? ''),
    });
  }
  // a steward runner job is a run of its project like any other (ISS-1255): live, it holds a slot;
  // due, it is a ready part, urgent where it is a release follow-through
  for (const [projectId, s] of steward) {
    inUse.set(projectId, (inUse.get(projectId) ?? 0) + s.live);
    const held = waiting.get(projectId) ?? { n: 0, urgent: false };
    waiting.set(projectId, { n: held.n + s.waiting, urgent: held.urgent || s.urgent });
  }
  const ids = new Set([...inUse.keys(), ...waiting.keys()]);
  if (opts.declaring) ids.add(opts.declaring);
  const demands: SlotDemand[] = [...ids].map((projectId) => {
    const runs = inUse.get(projectId) ?? 0;
    const ready = waiting.get(projectId)?.n ?? 0;
    return {
      projectId,
      wants: runs + (projectId === opts.declaring ? Math.max(ready, 1) : ready),
      urgent: waiting.get(projectId)?.urgent ?? false,
    };
  });
  const capacity = device?.maxSubagents ?? null;
  const slots = slotsFor(demands, capacity ?? 0);
  return {
    capacity,
    projects: demands.map((d) => ({
      projectId: d.projectId,
      wants: d.wants,
      slots: slots.get(d.projectId) ?? 0,
      inUse: inUse.get(d.projectId) ?? 0,
      waiting: waiting.get(d.projectId)?.n ?? 0,
      urgent: d.urgent,
    })),
  };
}

/**
 * One project's entry in its box's slots, as the master standing serves it. `waiting` is what the rule
 * was asked for less what is in use, so a steward job waiting for a slot reads as a wait like any run's.
 */
export function subagentSlotsOf(box: BoxSlots, projectId: string): MasterSubagentSlots {
  const mine = box.projects.find((p) => p.projectId === projectId);
  return {
    held: mine?.slots ?? 0,
    inUse: mine?.inUse ?? 0,
    waiting: Math.max(0, (mine?.wants ?? 0) - (mine?.inUse ?? 0)),
    capacity: box.capacity,
  };
}

/** The box's slots for a read: one read per box inside a read request's memo. */
export function readBoxSlotsForView(deviceId: string): Promise<BoxSlots> {
  return memoizedRead(`runSlots:${deviceId}`, () => readBoxSlots(deviceId));
}

function slotRefusal(projectId: string, box: BoxSlots, mine: ProjectSlots) {
  const withWork = box.projects.filter((p) => p.slots > 0).length;
  const capacity =
    box.capacity === null
      ? 'this box declares no `max_subagents` (`[runner]` in its runner config), so each project with work holds its floor of 1 alone'
      : `the box runs ${box.capacity} subagent(s) at once, shared by ${withWork} project(s) with work`;
  return refuseDevice(
    'RUN_SLOT_UNAVAILABLE',
    `project ${projectId} holds ${mine.slots} subagent slot(s) on this box and ${mine.inUse} are in use, ` +
      `so no run is opened: ${capacity}. One frees when a run of this project closes ` +
      '(`forge-runner run close`); nothing running is stopped. Declare this run again then.',
    '/projectId',
  );
}

/**
 * The box run id of a declaration of this project queued on this box for a slot, while the box still
 * re-sends it: one the reaper has not yet ended for silence. Null where none waits.
 */
async function slotWaiter(deviceId: string, projectId: string): Promise<string | null> {
  const [row] = (await db.execute(sql`
    SELECT r.metadata ->> 'boxRunId' AS box_run_id
      FROM agent_sessions s JOIN pipeline_runs r ON r.id = s.pipeline_run_id
     WHERE s.kind = ${RUN_SESSION_KIND} AND s.status = 'queued'
       AND s.project_id = ${projectId} AND s.device_id = ${deviceId}
       AND r.metadata -> ${RUN_DECLARATION_REFUSAL_METADATA_KEY} ->> 'code' = 'RUN_SLOT_UNAVAILABLE'
       AND COALESCE(s.last_heartbeat_at, s.created_at) >= now() - make_interval(secs => ${SESSION_SILENCE_TIMEOUT_S})
     ORDER BY s.created_at
     LIMIT 1
  `)) as unknown as Array<{ box_run_id: string | null }>;
  return row ? (row.box_run_id ?? 'unnamed') : null;
}

/**
 * Refuse a run this project has no free slot for on this box. Inside an open, `tx` serializes every
 * open on the box, so two declarations racing for the last slot cannot both take it.
 *
 * `yieldToQueued` is for work core starts on its own (the steward's jobs): a slot a master's
 * declaration is queued for goes to that declaration on the box's next re-send, so such work is
 * refused while one waits. A queued row holds no slot, and a tick that only asked whether one is free
 * took it first every time (ISS-1260).
 */
export async function refuseRunWithoutSlot(args: {
  deviceId: string;
  projectId: string;
  tx?: Tx;
  yieldToQueued?: boolean;
}): Promise<void> {
  if (args.yieldToQueued) {
    const waiter = await slotWaiter(args.deviceId, args.projectId);
    if (waiter) {
      throw refuseDevice(
        'RUN_SLOT_UNAVAILABLE',
        `project ${args.projectId} has a run declaration queued for a slot on this box (run ${waiter}), ` +
          "so the next free slot is that run's: work core starts on its own waits until it binds or the box stops re-sending it.",
        '/projectId',
      );
    }
  }
  if (args.tx) await lockXact(args.tx, 'runSession', `slots:${args.deviceId}`);
  const box = await readBoxSlots(args.deviceId, {
    declaring: args.projectId,
    ...(args.tx ? { executor: args.tx } : {}),
  });
  const mine = box.projects.find((p) => p.projectId === args.projectId);
  if (!mine) throw new Error('refuseRunWithoutSlot: the declaring project was not allocated');
  if (mine.inUse >= mine.slots) throw slotRefusal(args.projectId, box, mine);
}
