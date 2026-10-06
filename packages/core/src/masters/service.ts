import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterPassCloseReason,
  MasterPassRefusal,
  MasterPassSkip,
  MasterPassTrigger,
  MasterRefusal,
  MasterSessionResponse,
  MasterVerb,
} from '@forge/contracts/master-standing';
import type { MasterFacts, MasterVerdict } from '@forge/contracts/master-verdict';
import { scrubSecretsDeep } from '@forge/observability';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { mergeSessionMetadata } from '../agent-sessions/index.js';
import { db, type Tx } from '../db/client.js';
import { agentSessions, devices, runners, terminalAgentSessionStatuses } from '../db/schema.js';
import {
  assertDeviceBoundToProject,
  ensureMasterSession,
  setMaxJobPanes,
} from '../devices/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { closedPassOf, openPassOf, PASS_COLUMNS, readClosedPass, readOpenPass } from './read.js';
import {
  passAlreadyOpenRefusal,
  passNotOpenRefusal,
  refusedWithWorkRefusal,
  sessionEndedRefusal,
  slotsUndeclaredRefusal,
} from './rules.js';
import { masterVerdict } from './verdict.js';

type Refused = { ok: false; refusals: MasterRefusal[] };

type MasterSessionOutcome = { ok: true; session: MasterSessionResponse } | Refused;
type OpenPassOutcome = { ok: true; pass: MasterOpenPass } | Refused;
type ClosePassOutcome = { ok: true; pass: MasterClosedPass } | Refused;

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];

export async function declareMasterSession(args: {
  deviceId: string;
  projectId: string;
  name: string;
  maxJobPanes: number | undefined;
}): Promise<MasterSessionOutcome> {
  const [device] = await db
    .select({ agentVersion: devices.agentVersion, maxJobPanes: devices.maxJobPanes })
    .from(devices)
    .where(eq(devices.id, args.deviceId))
    .limit(1);
  if (!device) throw new Error(`declareMasterSession: device ${args.deviceId} has no row`);
  await assertDeviceBoundToProject(args.deviceId, args.projectId);
  const refusal = slotsUndeclaredRefusal({
    maxJobPanes: args.maxJobPanes,
    agentVersion: device.agentVersion,
  });
  if (refusal) return { ok: false, refusals: [refusal] };
  if (args.maxJobPanes !== undefined && args.maxJobPanes !== device.maxJobPanes) {
    await setMaxJobPanes(args.deviceId, args.maxJobPanes);
  }
  const session = await ensureMasterSession(args);
  return {
    ok: true,
    session: { ...session, maxJobPanes: args.maxJobPanes ?? device.maxJobPanes },
  };
}

async function lockMasterPasses(tx: Tx, sessionId: string): Promise<void> {
  await lockXact(tx, 'masterPass', sessionId);
}

async function ownedMaster(
  tx: Tx,
  deviceId: string,
  sessionId: string,
): Promise<{ id: string; projectId: string; status: string }> {
  const [row] = await tx
    .select({
      id: agentSessions.id,
      projectId: agentSessions.projectId,
      deviceId: agentSessions.deviceId,
      kind: agentSessions.kind,
      status: agentSessions.status,
    })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!row || row.kind !== MASTER_SESSION_KIND || row.deviceId !== deviceId) {
    throw new HTTPException(404, {
      message: `master session ${sessionId} not found on this device: name the sessionId POST /api/devices/me/master-session answered`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  return row;
}

export async function openMasterPass(args: {
  deviceId: string;
  sessionId: string;
  verb: MasterVerb;
  issueKey: string | null;
  trigger: MasterPassTrigger;
}): Promise<OpenPassOutcome> {
  return db.transaction(async (tx) => {
    await lockMasterPasses(tx, args.sessionId);
    const master = await ownedMaster(tx, args.deviceId, args.sessionId);
    const ended = sessionEndedRefusal(
      master.status,
      (terminalAgentSessionStatuses as readonly string[]).includes(master.status),
    );
    if (ended) return { ok: false, refusals: [ended] };
    const open = passAlreadyOpenRefusal(await readOpenPass(tx, master.id));
    if (open) return { ok: false, refusals: [open] };
    const [row] = rowsOf<Parameters<typeof openPassOf>[0]>(
      await tx.execute(sql`
        INSERT INTO master_passes (project_id, master_session_id, verb, issue_key, trigger)
        VALUES (${master.projectId}, ${master.id}, ${args.verb}, ${args.issueKey}, ${args.trigger})
        RETURNING ${PASS_COLUMNS}`),
    );
    if (!row) throw new Error('openMasterPass: the insert returned no row');
    return { ok: true, pass: openPassOf(row) };
  });
}

export async function closeMasterPass(args: {
  deviceId: string;
  sessionId: string;
  passId: string;
  dispatched: string[];
  skipped: MasterPassSkip[];
  parked: string[];
  refused: MasterPassRefusal | null;
  closeReason: MasterPassCloseReason | null;
}): Promise<ClosePassOutcome> {
  const withWork = refusedWithWorkRefusal(args);
  if (withWork) return { ok: false, refusals: [withWork] };
  return db.transaction(async (tx) => {
    await lockMasterPasses(tx, args.sessionId);
    const master = await ownedMaster(tx, args.deviceId, args.sessionId);
    const [row] = rowsOf<Parameters<typeof closedPassOf>[0]>(
      await tx.execute(sql`
        UPDATE master_passes
           SET ended_at = GREATEST(now(), started_at),
               dispatched = ${sql`ARRAY[${sql.join(
                 args.dispatched.map((d) => sql`${d}`),
                 sql`, `,
               )}]::text[]`},
               skipped = ${JSON.stringify(scrubSecretsDeep(args.skipped))}::jsonb,
               parked = ${sql`ARRAY[${sql.join(
                 args.parked.map((p) => sql`${p}`),
                 sql`, `,
               )}]::text[]`},
               refusal = ${args.refused ? JSON.stringify(scrubSecretsDeep(args.refused)) : null}::jsonb,
               close_reason = ${args.closeReason}
         WHERE id = ${args.passId} AND master_session_id = ${master.id} AND ended_at IS NULL
        RETURNING ${PASS_COLUMNS}`),
    );
    if (!row) {
      const [named, open] = await Promise.all([
        readClosedPass(tx, { sessionId: master.id, passId: args.passId }),
        readOpenPass(tx, master.id),
      ]);
      return { ok: false, refusals: [passNotOpenRefusal({ passId: args.passId, named, open })] };
    }
    return { ok: true, pass: closedPassOf(row) };
  });
}

/**
 * Record the dialog the runner read on its master's pane, or clear it with `null`. A fact the box saw,
 * kept on the master session so `masters/standing` reads waiting_person while it stands.
 */
export async function recordMasterDialog(args: {
  deviceId: string;
  sessionId: string;
  dialog: { text: string; source: 'pane' | 'hooks' } | null;
}): Promise<void> {
  await db.transaction(async (tx) => {
    await ownedMaster(tx, args.deviceId, args.sessionId);
    const paneDialog = args.dialog
      ? { ...scrubSecretsDeep(args.dialog), seenAt: new Date().toISOString() }
      : null;
    await mergeSessionMetadata(args.sessionId, { paneDialog }, tx);
  });
}

/**
 * Core's verdict on one project's resident master on the box sweeping `runnerId`: the box's facts,
 * its runner row's status and whether its live master has a pass open (ADR 0009, What core takes
 * over: Placement and Retirement).
 */
export async function judgeMaster(args: {
  deviceId: string;
  projectId: string;
  runnerId: string;
  facts: MasterFacts;
}): Promise<MasterVerdict> {
  await assertDeviceBoundToProject(args.deviceId, args.projectId);
  const [runner] = await db
    .select({ status: runners.status })
    .from(runners)
    .where(
      and(
        eq(runners.id, args.runnerId),
        eq(runners.deviceId, args.deviceId),
        eq(runners.projectId, args.projectId),
      ),
    )
    .limit(1);
  if (!runner) {
    throw new HTTPException(404, {
      message: `runner ${args.runnerId} is not this device's runner for project ${args.projectId}: name the runner row GET /api/devices/me/runners answered for it`,
      cause: { code: 'NOT_FOUND' },
    });
  }
  const [master] = await db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.deviceId, args.deviceId),
        eq(agentSessions.projectId, args.projectId),
        eq(agentSessions.kind, MASTER_SESSION_KIND),
        notInArray(agentSessions.status, [...terminalAgentSessionStatuses]),
      ),
    )
    .limit(1);
  const passOpen = master ? (await readOpenPass(db, master.id)) !== null : false;
  return masterVerdict(args.facts, { runnerStatus: runner.status, passOpen });
}
