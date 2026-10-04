import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type {
  MasterClosedPass,
  MasterOpenPass,
  MasterPassSkip,
  MasterRefusal,
  MasterSessionResponse,
  MasterVerb,
} from '@forge/contracts/master-standing';
import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { agentSessions, devices, terminalAgentSessionStatuses } from '../db/schema.js';
import { ensureMasterSession, setMaxJobPanes } from '../devices/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { closedPassOf, openPassOf, readClosedPass, readOpenPass } from './read.js';
import {
  passAlreadyOpenRefusal,
  passNotOpenRefusal,
  sessionEndedRefusal,
  slotsUndeclaredRefusal,
} from './rules.js';

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
        INSERT INTO master_passes (project_id, master_session_id, verb, issue_key)
        VALUES (${master.projectId}, ${master.id}, ${args.verb}, ${args.issueKey})
        RETURNING id, master_session_id, verb, issue_key, started_at, ended_at, dispatched, skipped, parked`),
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
}): Promise<ClosePassOutcome> {
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
               skipped = ${JSON.stringify(args.skipped)}::jsonb,
               parked = ${sql`ARRAY[${sql.join(
                 args.parked.map((p) => sql`${p}`),
                 sql`, `,
               )}]::text[]`}
         WHERE id = ${args.passId} AND master_session_id = ${master.id} AND ended_at IS NULL
        RETURNING id, master_session_id, verb, issue_key, started_at, ended_at, dispatched, skipped, parked`),
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
